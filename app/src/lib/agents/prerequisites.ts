/// The prerequisite check (lc-09), as the app reads it.
///
/// The host answers every prerequisite at once (`preflight`,
/// `app/src-tauri/src/preflight.rs`): git, Node, uv, Git for Windows'
/// sh.exe on Windows, and each agent CLI started with `--version`. What
/// this module adds is the part the host cannot know -- which of those
/// lines anything the human set up actually needs. Node missing is
/// nothing until Playwright is set up; a broken agent CLI is nothing
/// until it is the agent a workspace runs or falls back to. Only a
/// needed line is worth a notice; the Settings panel shows them all.

import type { HeadroomReading } from "$lib/agents/headroomSetup";
import type { PlaywrightMark, PlaywrightReading } from "$lib/agents/playwrightSetup";

export type PreflightState = "ok" | "missing" | "broken" | "unknown";

/// One row of the host's answer.
export interface PreflightItem {
  /// `git`, `node`, `uv`, `git-sh` (Windows only), or `agent:<profile id>`.
  id: string;
  label: string;
  state: PreflightState;
  /// The version line when ok, otherwise what was wrong.
  detail: string;
  fixHint: string | null;
  /// The agent profile, for an `agent:` row.
  profileId: string | null;
}

/// What the human has set up that a prerequisite could be needed BY.
export interface PrerequisiteNeeds {
  /// Playwright is set up -- the step's checks found its entry, or the
  /// human said they installed it. It runs through `npx`.
  playwright: boolean;
  /// Headroom is wanted and not installed yet, which gavin does with uv.
  /// An installed Headroom does not need uv to run.
  headroomInstall: boolean;
  /// Agent profiles something runs: a workspace's primary agent and its
  /// fallback chain, in order.
  agents: readonly string[];
}

export const NO_NEEDS: PrerequisiteNeeds = { playwright: false, headroomInstall: false, agents: [] };

export interface PrerequisiteLine {
  id: string;
  label: string;
  state: PreflightState;
  /// The row's sentence: its version, or what is wrong.
  detail: string;
  fixHint: string | null;
  /// What needs it, when something set up does; null otherwise.
  neededBy: string | null;
}

/// Whether a state is something to act on.
export function isProblem(state: PreflightState): boolean {
  return state === "missing" || state === "broken";
}

/// Why each kind of row is needed, or null when nothing set up needs it.
/// Git and Git for Windows' sh.exe are needed by any workspace at all:
/// card runs, worktrees and the Git tab run git, and on Windows every
/// emitted command line starts through that sh.exe.
function neededBy(item: PreflightItem, needs: PrerequisiteNeeds): string | null {
  if (item.id === "git") return "card runs, worktrees and the Git tab";
  if (item.id === "git-sh") return "every session that runs a command";
  if (item.id === "node") return needs.playwright ? "Playwright" : null;
  if (item.id === "uv") return needs.headroomInstall ? "installing Headroom" : null;
  if (item.profileId) {
    const at = needs.agents.indexOf(item.profileId);
    if (at === 0) return "this workspace's agent";
    if (at > 0) return "the fallback chain";
  }
  return null;
}

/// The lines to show, in the host's order. An agent CLI that is not on
/// this machine is listed only when something needs it: six "not found"
/// rows for CLIs nobody uses are noise, not a finding.
export function prerequisiteLines(
  items: readonly PreflightItem[],
  needs: PrerequisiteNeeds
): PrerequisiteLine[] {
  const out: PrerequisiteLine[] = [];
  for (const item of items) {
    const by = neededBy(item, needs);
    if (item.id.startsWith("agent:") && item.state === "missing" && !by) continue;
    out.push({
      id: item.id,
      label: item.label,
      state: item.state,
      detail: item.detail,
      fixHint: item.fixHint,
      neededBy: by,
    });
  }
  return out;
}

/// The lines worth a notice: needed, and missing or broken.
export function neededProblems(lines: readonly PrerequisiteLine[]): PrerequisiteLine[] {
  return lines.filter((l) => l.neededBy !== null && isProblem(l.state));
}

/// The Home notice's sentence, or null when nothing needed is wrong.
export function prerequisiteNotice(lines: readonly PrerequisiteLine[]): string | null {
  const problems = neededProblems(lines);
  if (problems.length === 0) return null;
  const parts = problems.map(
    (l) => `${l.label} ${l.state === "missing" ? "is missing" : "does not start"} (needed by ${l.neededBy})`
  );
  return `${parts.join("; ")}.`;
}

/// The word a state is shown under.
export function preflightStateLabel(state: PreflightState): string {
  switch (state) {
    case "ok":
      return "ok";
    case "missing":
      return "missing";
    case "broken":
      return "does not start";
    default:
      return "unknown";
  }
}

/// Whether Playwright is set up on this root: the human said so, or the
/// step's checks found gavin's entry in the MCP config -- either way an
/// agent will try to start it through `npx`.
export function playwrightNeedsNode(
  reading: PlaywrightReading | undefined,
  mark: PlaywrightMark | undefined
): boolean {
  if (mark === "installed") return true;
  if (reading?.kind !== "status") return false;
  return reading.status.checks.some((c) => c.id === "entry" && c.ok === true);
}

/// Whether Headroom is wanted and still to be installed -- the one time
/// gavin runs uv.
export function headroomNeedsUv(reading: HeadroomReading | undefined): boolean {
  return reading?.kind === "status" && reading.status.wanted && reading.status.state === "absent";
}

/// The agents a workspace runs: its primary, then its fallback chain,
/// without repeats or blanks.
export function agentsInUse(primary: string | null | undefined, chain: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of [primary ?? "", ...chain]) {
    const id = raw.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/// Each agent CLI's preflight verdict, by profile id: `runnable` true
/// when it started, false when it was found but did not, null when the
/// check could not say. A CLI that is not on the machine has no verdict
/// to give -- the PATH sweep already says "not found" -- and is absent.
export function agentVerdicts(
  items: readonly PreflightItem[]
): Map<string, { runnable: boolean | null; detail: string }> {
  const out = new Map<string, { runnable: boolean | null; detail: string }>();
  for (const item of items) {
    if (!item.profileId || item.state === "missing") continue;
    const runnable = item.state === "ok" ? true : item.state === "broken" ? false : null;
    out.set(item.profileId, { runnable, detail: item.detail });
  }
  return out;
}
