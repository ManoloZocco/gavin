import { describe, expect, it } from "vitest";
import {
  complexityTableEmpty,
  decidingLayer,
  effectiveRunForCard,
  emptyComplexityNote,
  resolveEffectiveConfig,
  runsOnBreakdown,
  runsOnLine,
  type EffectiveConfigInput,
} from "$lib/agents/effectiveConfig";
import {
  COMPLEXITY_LEVELS,
  EMPTY_AGENT_DEFAULTS,
  agentConfigWithAttribution,
  effectiveComplexityTable,
  type AgentDefaults,
} from "$lib/cards/complexity";
import { cardAgentEntry, type CardAgentFields } from "$lib/cards/cardAgent";
import { resolveAgentChoice, resolveAgentConfig, type AgentProfileInfo } from "$lib/core/settings";
import type { AgentConfig } from "$lib/core/gavin";

function profile(id: string, label: string): AgentProfileInfo {
  return {
    id,
    label,
    instructionsFile: "AGENTS.md",
    command: id,
    mcpSupported: true,
    mcpConfigFile: "",
    promptArgs: "",
    headlessArgs: "",
    modelFlag: "--model",
    models: [],
    effortFlag: "--effort",
    efforts: [],
    advisorFlag: id === "claude-code" ? "--advisor" : "",
    failurePatterns: [],
    failureCauses: [],
    sessionIdArgs: "",
    sessionIdDiscovery: "",
    resumeArgs: "",
    usageProbe: null,
  };
}

const PROFILES = [profile("claude-code", "Claude Code"), profile("codex", "Codex CLI"), profile("cursor", "Cursor")];

function cfg(fields: Partial<AgentConfig>): AgentConfig {
  return { profile: null, file: null, command: null, ...fields };
}

function input(over: {
  agentConfig?: AgentConfig | null;
  defaults?: Partial<AgentDefaults>;
  globalModels?: Record<string, string>;
  workspace?: EffectiveConfigInput["workspace"];
} = {}): EffectiveConfigInput {
  return {
    agentConfig: over.agentConfig ?? null,
    profiles: PROFILES,
    globalModels: over.globalModels ?? {},
    defaults: { ...EMPTY_AGENT_DEFAULTS, ...over.defaults },
    workspace: over.workspace ?? null,
  };
}

/// What the launcher (`agentForCard` / `cardAgents`) resolves for the
/// same inputs, through the same calls -- the view must never disagree.
function launched(i: EffectiveConfigInput, card: CardAgentFields | null) {
  const base = resolveAgentConfig(
    i.agentConfig,
    i.profiles,
    i.globalModels,
    undefined,
    undefined,
    i.defaults.agentEfforts,
    i.defaults.defaultAgent
  );
  const table = effectiveComplexityTable(
    i.workspace?.complexityTables,
    i.defaults.complexityTables,
    base.profileId
  );
  const agent = resolveAgentConfig(
    agentConfigWithAttribution(i.agentConfig, cardAgentEntry(card, table)),
    i.profiles,
    i.globalModels,
    undefined,
    undefined,
    i.defaults.agentEfforts,
    i.defaults.defaultAgent
  );
  return { agent: agent.profileId, model: agent.model, effort: agent.effort, advisor: agent.advisor };
}

function values(run: ReturnType<typeof effectiveRunForCard>) {
  return {
    agent: run.agent.value,
    model: run.model.value,
    effort: run.effort.value,
    advisor: run.advisor.value,
  };
}

describe("each layer winning", () => {
  it("falls to the built-in claude-code when the app names no default agent", () => {
    const run = resolveEffectiveConfig(input({ defaults: { defaultAgent: "" } })).unrated;
    expect(run.agent).toEqual({ value: "claude-code", layer: "builtin" });
    expect(run.agentLabel).toBe("Claude Code");
    expect(run.model).toEqual({ value: "", layer: "unset" });
    expect(run.effort).toEqual({ value: "", layer: "unset" });
    expect(run.advisor).toEqual({ value: "", layer: "unset" });
  });

  it("falls to the built-in when the app default names an agent that is not installed", () => {
    const run = resolveEffectiveConfig(input({ defaults: { defaultAgent: "gemini" } })).unrated;
    expect(run.agent).toEqual({ value: "claude-code", layer: "builtin" });
  });

  it("takes the app-wide default agent, model and effort", () => {
    const run = resolveEffectiveConfig(
      input({
        defaults: { defaultAgent: "codex", agentEfforts: { codex: "high" } },
        globalModels: { codex: "gpt-5" },
      })
    ).unrated;
    expect(run.agent).toEqual({ value: "codex", layer: "app" });
    expect(run.model).toEqual({ value: "gpt-5", layer: "app" });
    expect(run.effort).toEqual({ value: "high", layer: "app" });
  });

  it("lets the workspace's [agent] block beat the app", () => {
    const run = resolveEffectiveConfig(
      input({
        agentConfig: cfg({ profile: "codex", model: "o3", effort: "low" }),
        defaults: { defaultAgent: "claude-code", agentEfforts: { codex: "high" } },
        globalModels: { codex: "gpt-5" },
      })
    ).unrated;
    expect(run.agent).toEqual({ value: "codex", layer: "workspace" });
    expect(run.model).toEqual({ value: "o3", layer: "workspace" });
    expect(run.effort).toEqual({ value: "low", layer: "workspace" });
  });

  it("falls through a workspace profile that is not installed to the app default", () => {
    const run = resolveEffectiveConfig(
      input({ agentConfig: cfg({ profile: "nope" }), defaults: { defaultAgent: "codex" } })
    ).unrated;
    expect(run.agent).toEqual({ value: "codex", layer: "app" });
  });

  it("lets a complexity row beat the workspace, level by level", () => {
    const config = resolveEffectiveConfig(
      input({
        agentConfig: cfg({ profile: "claude-code", model: "sonnet" }),
        defaults: {
          complexityTables: {
            "claude-code": { complex: { profile: "", model: "opus", effort: "max", advisor: "opus" } },
          },
        },
      })
    );
    expect(config.levels.complex.agent).toEqual({ value: "claude-code", layer: "workspace" });
    expect(config.levels.complex.model).toEqual({ value: "opus", layer: "complexity" });
    expect(config.levels.complex.effort).toEqual({ value: "max", layer: "complexity" });
    expect(config.levels.complex.advisor).toEqual({ value: "opus", layer: "complexity" });
    // An unmapped level runs the workspace's own answer.
    expect(config.levels.trivial.model).toEqual({ value: "sonnet", layer: "workspace" });
    expect(config.unrated.model).toEqual({ value: "sonnet", layer: "workspace" });
    expect(config.complexityTableEmpty).toBe(false);
    expect(config.complexityTable).toEqual({ layer: "app", primary: "claude-code" });
  });

  it("tags a row that switches agent as complexity, and the switched agent's model as its app default", () => {
    const config = resolveEffectiveConfig(
      input({
        agentConfig: cfg({ profile: "claude-code", model: "sonnet" }),
        defaults: { complexityTables: { "claude-code": { simple: { profile: "codex", model: "" } } } },
        globalModels: { codex: "gpt-5-mini" },
      })
    );
    expect(config.levels.simple.agent).toEqual({ value: "codex", layer: "complexity" });
    // The workspace's model described claude-code's binary; it does not
    // follow the switch.
    expect(config.levels.simple.model).toEqual({ value: "gpt-5-mini", layer: "app" });
  });

  it("drops the workspace model for a same-agent row with no model, as the launcher does", () => {
    const i = input({
      agentConfig: cfg({ profile: "claude-code", model: "sonnet" }),
      defaults: { complexityTables: { "claude-code": { moderate: { profile: "claude-code", model: "", effort: "high" } } } },
      globalModels: { "claude-code": "opus" },
    });
    const run = resolveEffectiveConfig(i).levels.moderate;
    expect(run.agent).toEqual({ value: "claude-code", layer: "complexity" });
    expect(run.model).toEqual({ value: "opus", layer: "app" });
    expect(values(run)).toEqual(launched(i, { complexity: "moderate" }));
  });

  it("lets the card's own fields beat its level, whole", () => {
    const i = input({
      agentConfig: cfg({ profile: "claude-code" }),
      defaults: { complexityTables: { "claude-code": { complex: { profile: "", model: "opus", effort: "max" } } } },
    });
    const run = effectiveRunForCard(i, { complexity: "complex", agent: "codex", model: "gpt-5" });
    expect(run.agent).toEqual({ value: "codex", layer: "card" });
    expect(run.model).toEqual({ value: "gpt-5", layer: "card" });
    // The level's effort does not leak through a card that said anything.
    expect(run.effort).toEqual({ value: "", layer: "unset" });
    expect(decidingLayer(run)).toBe("card");
  });

  it("keeps the workspace's agent under a card that names only a model", () => {
    const run = effectiveRunForCard(input({ agentConfig: cfg({ profile: "codex" }) }), { model: "o3" });
    expect(run.agent).toEqual({ value: "codex", layer: "workspace" });
    expect(run.model).toEqual({ value: "o3", layer: "card" });
    expect(decidingLayer(run)).toBe("card");
  });

  it("reads a card naming an uninstalled agent back as the default it falls to", () => {
    const run = effectiveRunForCard(input({ defaults: { defaultAgent: "codex" } }), { agent: "typo" });
    expect(run.agent).toEqual({ value: "codex", layer: "app" });
  });

  it("agrees with the launcher's resolve across the layers", () => {
    const i = input({
      agentConfig: cfg({ profile: "claude-code", model: "sonnet", effort: "medium" }),
      defaults: {
        defaultAgent: "codex",
        agentEfforts: { codex: "high" },
        complexityTables: {
          "claude-code": {
            trivial: { profile: "codex", model: "" },
            complex: { profile: "", model: "opus", advisor: "opus" },
            intricate: { profile: "cursor", model: "auto", effort: "" },
          },
        },
      },
      globalModels: { codex: "gpt-5", cursor: "sonnet-4" },
    });
    const cards: (CardAgentFields | null)[] = [
      null,
      ...COMPLEXITY_LEVELS.map((complexity) => ({ complexity })),
      { complexity: "complex", agent: "codex" },
      { model: "haiku" },
      { effort: "max" },
      { agent: "cursor", model: "auto", effort: "low" },
    ];
    for (const card of cards) {
      expect(values(effectiveRunForCard(i, card))).toEqual(launched(i, card));
    }
  });
});

describe("the complexity table", () => {
  it("ships empty, and says so", () => {
    const config = resolveEffectiveConfig(input());
    expect(config.complexityTableEmpty).toBe(true);
    expect(config.complexityTable).toEqual({ layer: "builtin", primary: "claude-code" });
    for (const level of COMPLEXITY_LEVELS) {
      expect(values(config.levels[level])).toEqual(values(config.unrated));
    }
  });

  it("lets an EMPTY workspace table replace a filled app one", () => {
    const config = resolveEffectiveConfig(
      input({
        defaults: { complexityTables: { "claude-code": { complex: { profile: "codex", model: "" } } } },
        workspace: { complexityTables: { "claude-code": {} } },
      })
    );
    expect(config.complexityTableEmpty).toBe(true);
    expect(config.complexityTable.layer).toBe("workspace");
    expect(config.levels.complex.agent).toEqual({ value: "claude-code", layer: "app" });
  });

  it("reads the workspace's own table over the app's", () => {
    const config = resolveEffectiveConfig(
      input({
        defaults: { complexityTables: { "claude-code": { complex: { profile: "codex", model: "" } } } },
        workspace: { complexityTables: { "claude-code": { complex: { profile: "cursor", model: "" } } } },
      })
    );
    expect(config.levels.complex.agent).toEqual({ value: "cursor", layer: "complexity" });
    expect(config.complexityTable.layer).toBe("workspace");
  });

  it("keys the table by the workspace's agent, not another agent's", () => {
    const config = resolveEffectiveConfig(
      input({
        agentConfig: cfg({ profile: "codex" }),
        defaults: { complexityTables: { "claude-code": { complex: { profile: "", model: "opus" } } } },
      })
    );
    expect(config.complexityTableEmpty).toBe(true);
    expect(config.complexityTable).toEqual({ layer: "builtin", primary: "codex" });
  });

  it("counts an effort-only or advisor-only row as mapped", () => {
    expect(complexityTableEmpty({})).toBe(true);
    expect(complexityTableEmpty({ simple: { profile: " ", model: "" } })).toBe(true);
    expect(complexityTableEmpty({ simple: { profile: "", model: "", effort: "low" } })).toBe(false);
    expect(complexityTableEmpty({ simple: { profile: "", model: "", advisor: "opus" } })).toBe(false);
  });

  it("notes an empty table and stays quiet for a mapped one", () => {
    expect(emptyComplexityNote({}, "Codex CLI")).toContain("complexity ratings have no effect");
    expect(emptyComplexityNote({}, "Codex CLI")).toContain("runs Codex CLI");
    expect(emptyComplexityNote({ complex: { profile: "", model: "opus" } }, "Codex CLI")).toBeNull();
  });
});

describe("the fallback chain and the pause", () => {
  it("has no chain, no limit gate and the shipped thresholds when nothing is configured", () => {
    const run = resolveEffectiveConfig(input()).unrated;
    expect(run.fallback).toEqual({ chain: [], chainLayer: "builtin", thresholdPercent: 90, thresholdLayer: "builtin" });
    expect(run.pause).toEqual({ cycleEnabled: false, limitEnabled: false, limitPercent: 95, layer: "builtin" });
  });

  it("reports an app-wide chain with each hop's threshold, and turns the limit gate on", () => {
    const run = resolveEffectiveConfig(
      input({
        defaults: {
          fallbackChains: { "claude-code": ["codex", "cursor"] },
          fallbackThresholds: { "claude-code": 85, codex: 80 },
        },
      })
    ).unrated;
    expect(run.fallback).toEqual({
      chain: [
        { agent: "codex", thresholdPercent: 80 },
        { agent: "cursor", thresholdPercent: 90 },
      ],
      chainLayer: "app",
      thresholdPercent: 85,
      thresholdLayer: "app",
    });
    expect(run.pause.limitEnabled).toBe(true);
    expect(run.pause.limitPercent).toBe(95);
  });

  it("lets an EMPTY workspace chain replace the app's", () => {
    const run = resolveEffectiveConfig(
      input({
        defaults: { fallbackChains: { "claude-code": ["codex"] } },
        workspace: { fallbackChains: { "claude-code": [] } },
      })
    ).unrated;
    expect(run.fallback.chain).toEqual([]);
    expect(run.fallback.chainLayer).toBe("workspace");
    expect(run.pause.limitEnabled).toBe(false);
  });

  it("reads an unusable stored threshold as the shipped one", () => {
    const run = resolveEffectiveConfig(input({ defaults: { fallbackThresholds: { "claude-code": 0 } } })).unrated;
    expect(run.fallback.thresholdPercent).toBe(90);
    expect(run.fallback.thresholdLayer).toBe("builtin");
  });

  it("reads the chain and the cycle of the agent a level routes to", () => {
    const config = resolveEffectiveConfig(
      input({
        defaults: {
          complexityTables: { "claude-code": { complex: { profile: "codex", model: "" } } },
          fallbackChains: { codex: ["cursor"] },
          pauseCycles: {
            codex: { enabled: true, periodMinutes: 300, pauseMinutes: 10, anchorMs: 0, limitPercent: 97, limitEnabled: true },
          },
        },
      })
    );
    expect(config.unrated.fallback.chain).toEqual([]);
    expect(config.levels.complex.fallback.chain).toEqual([{ agent: "cursor", thresholdPercent: 90 }]);
    expect(config.levels.complex.pause).toEqual({
      cycleEnabled: true,
      limitEnabled: true,
      limitPercent: 97,
      layer: "app",
    });
  });

  it("lets a workspace's switched-off cycle replace the app's", () => {
    const appCycle = { enabled: true, periodMinutes: 300, pauseMinutes: 10, anchorMs: 0, limitPercent: 97, limitEnabled: true };
    const run = resolveEffectiveConfig(
      input({
        defaults: { pauseCycles: { "claude-code": appCycle } },
        workspace: { pauseCycles: { "claude-code": { ...appCycle, enabled: false, limitEnabled: false, limitPercent: 99 } } },
      })
    ).unrated;
    expect(run.pause).toEqual({ cycleEnabled: false, limitEnabled: false, limitPercent: 99, layer: "workspace" });
  });
});

describe("the Runs on line", () => {
  it("names the agent's own defaults rather than leaving them out", () => {
    const run = resolveEffectiveConfig(input()).unrated;
    expect(runsOnLine(run)).toBe(
      "Runs on: Claude Code · default model · default effort (from the app-wide defaults)"
    );
  });

  it("names the deciding layer and the advisor", () => {
    const run = resolveEffectiveConfig(
      input({
        agentConfig: cfg({ profile: "claude-code" }),
        defaults: { complexityTables: { "claude-code": { intricate: { profile: "", model: "opus", effort: "max", advisor: "fable" } } } },
      })
    ).levels.intricate;
    expect(runsOnLine(run)).toBe(
      "Runs on: Claude Code · opus · max · advised by fable (from the complexity table)"
    );
    expect(runsOnBreakdown(run)).toBe(
      "Agent from this workspace; model from the complexity table; effort from the complexity table; advisor from the complexity table."
    );
  });

  it("says a card's own fields decided it", () => {
    const run = effectiveRunForCard(input(), { agent: "codex", effort: "high" });
    expect(runsOnLine(run)).toBe("Runs on: Codex CLI · default model · high (from this card)");
  });
});

describe("the JSON shape", () => {
  it("round-trips through JSON unchanged, for the MCP tool", () => {
    const config = resolveEffectiveConfig(
      input({
        agentConfig: cfg({ profile: "codex", model: "o3" }),
        defaults: {
          fallbackChains: { codex: ["claude-code"] },
          complexityTables: { codex: { complex: { profile: "claude-code", model: "opus" } } },
        },
      })
    );
    expect(JSON.parse(JSON.stringify(config))).toEqual(config);
    expect(Object.keys(config.levels)).toEqual([...COMPLEXITY_LEVELS]);
  });
});

describe("resolveAgentChoice", () => {
  it("returns resolveAgentConfig's four values", () => {
    const config = cfg({ profile: "codex", effort: "low", advisor: "opus" });
    const choice = resolveAgentChoice(config, PROFILES, { codex: "gpt-5" }, {}, "claude-code");
    const resolved = resolveAgentConfig(config, PROFILES, { codex: "gpt-5" }, undefined, undefined, {}, "claude-code");
    expect([choice.profileId, choice.model, choice.effort, choice.advisor]).toEqual([
      resolved.profileId,
      resolved.model,
      resolved.effort,
      resolved.advisor,
    ]);
    expect(choice.layers).toEqual({ profile: "config", model: "app", effort: "config", advisor: "config" });
  });

  it("tags the default agent as the app's while the profile table is still loading", () => {
    const choice = resolveAgentChoice(cfg({ profile: "codex" }), [], {}, {}, "cursor");
    expect(choice.profileId).toBe("cursor");
    expect(choice.layers.profile).toBe("app");
  });
});
