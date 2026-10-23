// Which agent, model, effort and advisor a card in this workspace will
// actually run on, and which layer of settings decided each one.
//
// Five layers answer that question -- the card's own fields, its
// complexity level's row, the workspace's `[agent]` block, the app-wide
// per-profile defaults, and `claude-code` at the bottom -- and nothing
// put the answer in one place, so the human (and an agent rating cards)
// had to replay all five in their head. This module replays them with
// the functions the launchers themselves call (`cardAgentEntry`,
// `agentConfigWithAttribution`, `resolveAgentChoice`,
// `effectiveComplexityTable`, `effectiveFallbackChain`,
// `effectivePauseCycle`, `launchLimitGate`, `fallbackThresholdFor`) and
// only adds the layer each value came from. It decides nothing of its
// own: a second copy of the precedence is how the view and the launch
// would start disagreeing.
//
// The output is plain JSON on purpose, so the read-only MCP tool
// `gavin_get_effective_config` can return the same shape:
//
//   EffectiveConfig = {
//     unrated: EffectiveRun,                         // a card with no level and no override
//     levels: { trivial|simple|moderate|complex|intricate: EffectiveRun },
//     complexityTable: { layer: "workspace"|"app"|"builtin", primary: string },
//     complexityTableEmpty: boolean,                  // ratings route nowhere yet
//   }
//   EffectiveRun = {
//     agent:   { value: string, layer: ConfigLayer }, // profile id
//     agentLabel: string,
//     model:   { value: string, layer: ConfigLayer }, // "" + "unset" = agent's own default
//     effort:  { value: string, layer: ConfigLayer },
//     advisor: { value: string, layer: ConfigLayer },
//     fallback: {
//       chain: [{ agent: string, thresholdPercent: number }],
//       chainLayer: "workspace"|"app"|"builtin",      // builtin = none configured: pause only
//       thresholdPercent: number,                     // the primary is spent for a NEW launch here
//       thresholdLayer: "app"|"builtin",
//     },
//     pause: {
//       cycleEnabled: boolean,
//       limitEnabled: boolean,
//       limitPercent: number,                         // a resume is held here
//       layer: "workspace"|"app"|"builtin",
//     },
//   }
//   ConfigLayer = "card"|"complexity"|"workspace"|"app"|"builtin"|"unset"
//
// Pure and unit-tested; the card detail modal and the Agents settings
// are templates over it.

import {
  COMPLEXITY_LEVELS,
  agentConfigWithAttribution,
  effectiveComplexityTable,
  isAttributed,
  type AgentDefaults,
  type Complexity,
  type ComplexityAgent,
  type ComplexityTable,
} from "$lib/cards/complexity";
import { cardAgentEntry, cardAgentOverride, type CardAgentFields } from "$lib/cards/cardAgent";
import {
  effectiveFallbackChain,
  fallbackThresholdFor,
  launchLimitGate,
} from "$lib/agents/agentFallback";
import { effectivePauseCycle } from "$lib/agents/agentPause";
import { resolveAgentChoice, type AgentInputLayer, type AgentProfileInfo } from "$lib/core/settings";
import type { AgentConfig } from "$lib/core/gavin";
import type { Workspace } from "$lib/core/workspace";

/// Where a value came from, highest precedence first. `unset` is not a
/// layer anybody wrote: nothing named a value, so the agent's own
/// default applies -- said apart from `builtin` because gavin passes
/// nothing at all then, rather than a value it chose.
export type ConfigLayer = "card" | "complexity" | "workspace" | "app" | "builtin" | "unset";

/// The layers a per-agent map (table, chain, cycle) can come from: the
/// workspace's own key, the app-wide key, or the shipped empty state.
export type ScopeLayer = "workspace" | "app" | "builtin";

export const CONFIG_LAYER_ORDER: readonly ConfigLayer[] = [
  "card",
  "complexity",
  "workspace",
  "app",
  "builtin",
  "unset",
];

/// How a layer is named on screen, in "(from …)".
export const CONFIG_LAYER_LABELS: Record<ConfigLayer, string> = {
  card: "this card",
  complexity: "the complexity table",
  workspace: "this workspace",
  app: "the app-wide defaults",
  builtin: "gavin's built-in default",
  unset: "the agent's own default",
};

export interface LayeredValue {
  value: string;
  layer: ConfigLayer;
}

export interface EffectiveFallback {
  /// The configured fallbacks for the run's agent, in walk order. The
  /// workspace's own agent is tried before them when it is not the run's
  /// agent (`decideLaunch`), and card fields never ride along onto a
  /// fallback (`complexityAttributionForProfile`).
  chain: { agent: string; thresholdPercent: number }[];
  chainLayer: ScopeLayer;
  /// The usage percent at which the run's agent counts as spent for a
  /// NEW launch, so the chain is walked.
  thresholdPercent: number;
  thresholdLayer: "app" | "builtin";
}

export interface EffectivePause {
  cycleEnabled: boolean;
  /// Whether usage limits gate this agent at all (`launchLimitGate`).
  limitEnabled: boolean;
  /// The percent at which a RESUME of this agent is held -- a different,
  /// higher number than the fallback threshold on purpose: the margin
  /// between the two is left for conversations already in flight.
  limitPercent: number;
  layer: ScopeLayer;
}

export interface EffectiveRun {
  agent: LayeredValue;
  agentLabel: string;
  model: LayeredValue;
  effort: LayeredValue;
  advisor: LayeredValue;
  fallback: EffectiveFallback;
  pause: EffectivePause;
}

export interface EffectiveConfig {
  unrated: EffectiveRun;
  levels: Record<Complexity, EffectiveRun>;
  /// Whose table the levels were read from: the workspace's own key for
  /// its agent, else the app-wide one, else the shipped (empty) state.
  complexityTable: { layer: ScopeLayer; primary: string };
  /// No level names anything, so a card's `complexity:` changes nothing
  /// about its run until somebody maps the levels.
  complexityTableEmpty: boolean;
}

/// Everything the resolve reads, as data. The caller gathers it from the
/// stores (`effectiveConfigInputs`); a test hands literals.
export interface EffectiveConfigInput {
  /// The workspace's own `[agent]` block, unresolved.
  agentConfig: AgentConfig | null | undefined;
  /// The merged profile table (`mergeAgentProfiles`).
  profiles: AgentProfileInfo[];
  /// The app-wide default model per profile id.
  globalModels: Record<string, string>;
  defaults: AgentDefaults;
  workspace:
    | Pick<Workspace, "complexityTables" | "pauseCycles" | "fallbackChains">
    | null
    | undefined;
}

function owns(map: Record<string, unknown> | null | undefined, key: string): boolean {
  return Boolean(key && map && Object.prototype.hasOwnProperty.call(map, key));
}

/// Which scope a per-agent map's effective value came from. Mirrors the
/// key-is-present rule every `effective*` reader uses: a workspace key
/// wins even when its value is empty.
function scopeLayer(
  workspaceMap: Record<string, unknown> | null | undefined,
  appMap: Record<string, unknown> | null | undefined,
  primaryId: string
): ScopeLayer {
  if (owns(workspaceMap, primaryId)) return "workspace";
  if (owns(appMap, primaryId)) return "app";
  return "builtin";
}

/// Whether a table maps any level to anything.
export function complexityTableEmpty(table: ComplexityTable | null | undefined): boolean {
  return !COMPLEXITY_LEVELS.some((level) => isAttributed(table?.[level]));
}

/// Splits the resolver's "config" layer into who wrote that config: the
/// attribution (card or level) when the value is the attribution's own,
/// else the workspace's `[agent]` block underneath it.
function splitConfigLayer(
  layer: AgentInputLayer,
  value: string,
  attributed: string | null | undefined,
  attributionLayer: ConfigLayer | null
): ConfigLayer {
  if (layer !== "config") return layer;
  const own = (attributed ?? "").trim();
  return attributionLayer && own && own === value ? attributionLayer : "workspace";
}

function fallbackFor(input: EffectiveConfigInput, primaryId: string): EffectiveFallback {
  const appChains = input.defaults.fallbackChains;
  const thresholds = input.defaults.fallbackThresholds;
  const chain = effectiveFallbackChain(input.workspace?.fallbackChains, appChains, primaryId);
  const thresholdPercent = fallbackThresholdFor(primaryId, thresholds);
  return {
    chain: chain.map((agent) => ({ agent, thresholdPercent: fallbackThresholdFor(agent, thresholds) })),
    chainLayer: scopeLayer(input.workspace?.fallbackChains, appChains, primaryId),
    thresholdPercent,
    // Only a stored value that `fallbackThresholdFor` accepted counts as
    // the app's: an unusable one reads as the shipped default.
    thresholdLayer:
      owns(thresholds, primaryId) && thresholds[primaryId] === thresholdPercent ? "app" : "builtin",
  };
}

function pauseFor(input: EffectiveConfigInput, primaryId: string, chain: readonly string[]): EffectivePause {
  const appCycles = input.defaults.pauseCycles;
  const cycle = effectivePauseCycle(input.workspace?.pauseCycles, appCycles, primaryId);
  return {
    cycleEnabled: Boolean(cycle?.enabled),
    ...launchLimitGate(cycle, chain),
    layer: scopeLayer(input.workspace?.pauseCycles, appCycles, primaryId),
  };
}

/// One run: the workspace's `[agent]` block with `entry` laid over it,
/// resolved the way every launcher resolves it, each value tagged.
function runFor(
  input: EffectiveConfigInput,
  entry: ComplexityAgent | null,
  entryLayer: ConfigLayer
): EffectiveRun {
  const choice = choiceFor(input, agentConfigWithAttribution(input.agentConfig, entry));
  const from = entry ? entryLayer : null;
  const fallback = fallbackFor(input, choice.profileId);
  return {
    agent: {
      value: choice.profileId,
      layer: splitConfigLayer(choice.layers.profile, choice.profileId, entry?.profile, from),
    },
    agentLabel: choice.effective?.label ?? choice.profileId,
    model: {
      value: choice.model,
      layer: splitConfigLayer(choice.layers.model, choice.model, entry?.model, from),
    },
    effort: {
      value: choice.effort,
      layer: splitConfigLayer(choice.layers.effort, choice.effort, entry?.effort, from),
    },
    advisor: {
      value: choice.advisor,
      layer: splitConfigLayer(choice.layers.advisor, choice.advisor, entry?.advisor, from),
    },
    fallback,
    pause: pauseFor(input, choice.profileId, fallback.chain.map((hop) => hop.agent)),
  };
}

function choiceFor(input: EffectiveConfigInput, config: AgentConfig | null | undefined) {
  return resolveAgentChoice(
    config,
    input.profiles,
    input.globalModels,
    input.defaults.agentEfforts ?? {},
    input.defaults.defaultAgent
  );
}

/// The table a card in this workspace is rated against: the one of the
/// agent the workspace's own `[agent]` block resolves to, as
/// `agentForCard` keys it -- a rated card may switch agent, but the
/// rating is a statement about running here.
function tableFor(input: EffectiveConfigInput): { table: ComplexityTable; primary: string } {
  const primary = choiceFor(input, input.agentConfig).profileId;
  return {
    table: effectiveComplexityTable(
      input.workspace?.complexityTables,
      input.defaults.complexityTables,
      primary
    ),
    primary,
  };
}

function runForCardIn(
  input: EffectiveConfigInput,
  table: ComplexityTable,
  card: CardAgentFields | null | undefined
): EffectiveRun {
  return runFor(input, cardAgentEntry(card, table), cardAgentOverride(card) ? "card" : "complexity");
}

/// The resolved config for a workspace: what an unrated card runs on,
/// what each level runs on, and whether the levels say anything at all.
export function resolveEffectiveConfig(input: EffectiveConfigInput): EffectiveConfig {
  const { table, primary } = tableFor(input);
  const levels = {} as Record<Complexity, EffectiveRun>;
  for (const level of COMPLEXITY_LEVELS) {
    levels[level] = runForCardIn(input, table, { complexity: level });
  }
  return {
    unrated: runForCardIn(input, table, null),
    levels,
    complexityTable: {
      layer: scopeLayer(input.workspace?.complexityTables, input.defaults.complexityTables, primary),
      primary,
    },
    complexityTableEmpty: complexityTableEmpty(table),
  };
}

/// What one card runs on: its own override when it names anything,
/// else its level's row, else the workspace's agent (`cardAgentEntry`
/// decides which; this only says which one it was).
export function effectiveRunForCard(
  input: EffectiveConfigInput,
  card: CardAgentFields | null | undefined
): EffectiveRun {
  return runForCardIn(input, tableFor(input).table, card);
}

/// The layer that decided a run: the highest-precedence one among the
/// values that are set. A card naming only `model:` still ran because of
/// the card, even though its agent is the workspace's.
export function decidingLayer(run: EffectiveRun): ConfigLayer {
  const layers = [run.agent, run.model, run.effort, run.advisor]
    .filter((v) => v.layer !== "unset")
    .map((v) => v.layer);
  return CONFIG_LAYER_ORDER.find((layer) => layers.includes(layer)) ?? "unset";
}

/// "Runs on: Claude Code · opus · high (from this card)". An unset model
/// or effort is said as the agent's default rather than left out, so the
/// line never reads as if gavin chose something it did not.
export function runsOnLine(run: EffectiveRun): string {
  const parts = [
    run.agentLabel,
    run.model.value || "default model",
    run.effort.value || "default effort",
  ];
  if (run.advisor.value) parts.push(`advised by ${run.advisor.value}`);
  return `Runs on: ${parts.join(" · ")} (from ${CONFIG_LAYER_LABELS[decidingLayer(run)]})`;
}

/// The per-value breakdown behind `runsOnLine`, for its tooltip: which
/// layer each of the four values came from.
export function runsOnBreakdown(run: EffectiveRun): string {
  const say = (name: string, v: LayeredValue) => `${name} from ${CONFIG_LAYER_LABELS[v.layer]}`;
  const parts = [say("Agent", run.agent), say("model", run.model), say("effort", run.effort)];
  if (run.advisor.value) parts.push(say("advisor", run.advisor));
  return `${parts.join("; ")}.`;
}

/// The note under an empty complexity table: the agent rating cards has
/// been told the human maps each level, so until somebody does, its
/// ratings are recorded and change nothing. Null when any level is
/// mapped.
export function emptyComplexityNote(
  table: ComplexityTable | null | undefined,
  agentLabel: string
): string | null {
  return complexityTableEmpty(table)
    ? `No level is mapped yet, so complexity ratings have no effect: every rated card runs ${agentLabel} at its usual model and effort until a level names something.`
    : null;
}
