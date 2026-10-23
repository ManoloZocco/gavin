import { describe, expect, it } from "vitest";
import {
  detectWarnings,
  foundAgentsSummary,
  foundProfileIds,
  isAgentFound,
  missingFromAppFallback,
  suggestFallbackChain,
  suggestMainProfile,
  usableProfileIds,
  brokenProfileIds,
  withRunnability,
  type DetectedAgent,
} from "$lib/agents/agentDetect";

function row(
  over: Partial<DetectedAgent> & Pick<DetectedAgent, "id" | "found">
): DetectedAgent {
  return {
    label: over.id,
    command: over.id,
    path: over.found ? `/bin/${over.id}` : null,
    ...over,
  };
}

const SWEEP: DetectedAgent[] = [
  row({ id: "claude-code", label: "Claude Code", found: true }),
  row({ id: "codex", label: "Codex", found: false }),
  row({ id: "gemini", label: "Gemini", found: true }),
  row({ id: "cursor", label: "Cursor Agent", found: false }),
  row({ id: "opencode", label: "OpenCode", found: true }),
];

describe("foundProfileIds / isAgentFound", () => {
  it("lists only PATH hits", () => {
    expect(foundProfileIds(SWEEP)).toEqual(["claude-code", "gemini", "opencode"]);
    expect(isAgentFound(SWEEP, "gemini")).toBe(true);
    expect(isAgentFound(SWEEP, "codex")).toBe(false);
    expect(isAgentFound(SWEEP, "custom")).toBe(false);
  });
});

describe("suggestMainProfile", () => {
  it("does not override once a command is already written", () => {
    expect(
      suggestMainProfile({
        detected: SWEEP,
        currentProfileId: "codex",
        appChains: { "claude-code": ["gemini"] },
        commandAlreadySet: true,
      })
    ).toBe("codex");
  });

  it("keeps the current profile when it is found", () => {
    expect(
      suggestMainProfile({
        detected: SWEEP,
        currentProfileId: "opencode",
        appChains: { "claude-code": ["gemini"] },
        commandAlreadySet: false,
      })
    ).toBe("opencode");
  });

  it("prefers a found id from any primary's chain over the first found", () => {
    expect(
      suggestMainProfile({
        detected: SWEEP,
        currentProfileId: "codex",
        appChains: { "claude-code": ["cursor"], gemini: ["gemini", "opencode"] },
        commandAlreadySet: false,
      })
    ).toBe("gemini");
  });

  it("falls back to the first found CLI when settings name nothing usable", () => {
    expect(
      suggestMainProfile({
        detected: SWEEP,
        currentProfileId: "codex",
        appChains: { "claude-code": ["cursor"] },
        commandAlreadySet: false,
      })
    ).toBe("claude-code");
  });
});

describe("suggestFallbackChain", () => {
  it("leaves an existing chain for the main profile alone", () => {
    expect(
      suggestFallbackChain({
        detected: SWEEP,
        mainProfileId: "claude-code",
        appChains: { "claude-code": ["codex", "gemini"] },
      })
    ).toBeNull();
  });

  it("seeds other found agents when the main profile has no chain yet", () => {
    expect(
      suggestFallbackChain({
        detected: SWEEP,
        mainProfileId: "claude-code",
        appChains: {},
      })
    ).toEqual(["gemini", "opencode"]);
  });

  it("still seeds for a primary another primary's chain does not cover", () => {
    expect(
      suggestFallbackChain({
        detected: SWEEP,
        mainProfileId: "gemini",
        appChains: { "claude-code": ["codex"] },
      })
    ).toEqual(["claude-code", "opencode"]);
  });
});

describe("missingFromAppFallback", () => {
  it("names ids in the main profile's chain the sweep marked missing", () => {
    expect(
      missingFromAppFallback(SWEEP, { "claude-code": ["codex", "gemini", "cursor"] }, "claude-code")
    ).toEqual(["codex", "cursor"]);
  });

  it("says nothing for a primary with no chain", () => {
    expect(missingFromAppFallback(SWEEP, { "claude-code": ["codex"] }, "gemini")).toEqual([]);
  });
});

describe("foundAgentsSummary", () => {
  it("lists found labels", () => {
    expect(foundAgentsSummary(SWEEP)).toBe("Found: Claude Code, Gemini, OpenCode.");
  });

  it("explains an empty sweep", () => {
    expect(foundAgentsSummary(SWEEP.map((d) => ({ ...d, found: false, path: null })))).toBe(
      "None of gavin's built-in agent CLIs were found on PATH."
    );
  });
});

describe("detectWarnings", () => {
  it("collects non-empty warnings from the sweep", () => {
    expect(
      detectWarnings([
        row({ id: "claude-code", found: true }),
        row({
          id: "gemini",
          found: true,
          warning: "Gemini CLI is deprecated — install Antigravity CLI (`agy`).",
        }),
      ])
    ).toEqual(["Gemini CLI is deprecated — install Antigravity CLI (`agy`)."]);
  });

  it("ignores missing or blank warnings", () => {
    expect(
      detectWarnings([
        row({ id: "gemini", found: true, warning: null }),
        row({ id: "cursor", found: false, warning: "  " }),
      ])
    ).toEqual([]);
  });
});

// Found is not runnable (lc-09): the sweep sees a file on PATH, the
// prerequisite check starts it with `--version`. One that does not answer
// is listed, but never picked for the human.
describe("runnability from the prerequisite check", () => {
  const verdicts = new Map([
    ["claude-code", { runnable: false, detail: "claude exited with 1: licence expired" }],
    ["gemini", { runnable: true, detail: "1.0.0" }],
    ["codex", { runnable: true, detail: "ignored: not found" }],
  ]);
  const PROBED = withRunnability(SWEEP, verdicts);

  it("folds the verdicts into found rows only", () => {
    expect(PROBED.find((d) => d.id === "claude-code")?.runnable).toBe(false);
    expect(PROBED.find((d) => d.id === "claude-code")?.runnableDetail).toContain("licence expired");
    expect(PROBED.find((d) => d.id === "gemini")?.runnable).toBe(true);
    expect(PROBED.find((d) => d.id === "codex")?.runnable).toBeUndefined();
    expect(PROBED.find((d) => d.id === "opencode")?.runnable).toBeUndefined();
    expect(usableProfileIds(PROBED)).toEqual(["gemini", "opencode"]);
    expect(brokenProfileIds(PROBED)).toEqual(["claude-code"]);
  });

  it("never picks a CLI that does not start, even the current one", () => {
    const pick = (currentProfileId: string | null) =>
      suggestMainProfile({ detected: PROBED, currentProfileId, appChains: {}, commandAlreadySet: false });
    expect(pick(null)).toBe("gemini");
    expect(pick("claude-code")).toBe("gemini");
  });

  it("does not seed a fallback chain with it either", () => {
    expect(suggestFallbackChain({ detected: PROBED, mainProfileId: "gemini", appChains: {} })).toEqual([
      "opencode",
    ]);
  });

  it("says which found CLIs do not start", () => {
    expect(foundAgentsSummary(PROBED)).toBe("Found: Gemini, OpenCode. Found but not starting: Claude Code.");
  });

  it("keeps the old behaviour when nothing was probed", () => {
    expect(withRunnability(SWEEP, new Map())).toEqual(SWEEP);
    expect(usableProfileIds(SWEEP)).toEqual(foundProfileIds(SWEEP));
  });
});
