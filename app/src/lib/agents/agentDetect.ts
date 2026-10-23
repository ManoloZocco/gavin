/// Init-wizard PATH sweep: which built-in agent CLIs resolve, and how that
/// should seed the main profile and app-wide fallback chain.
///
/// Rust owns the probe (`detect_agent_binaries`); this module owns the
/// pure decisions the Agent step makes from that list plus app settings.

export interface DetectedAgent {
  id: string;
  label: string;
  command: string;
  found: boolean;
  path: string | null;
  /** Deprecation note when startable but not the preferred binary. */
  warning?: string | null;
  /// Whether the CLI answered `--version` (the prerequisite check,
  /// lc-09): false is FOUND BUT NOT RUNNABLE -- a broken install, a shim
  /// whose runtime is gone -- which the PATH sweep alone reports as
  /// found. Null or absent when it was not asked or could not say.
  runnable?: boolean | null;
  /// What the probe saw when `runnable` is false.
  runnableDetail?: string | null;
}

/// The sweep's rows with the prerequisite check's verdict folded in, by
/// profile id. A row the check has no answer for keeps `runnable`
/// unknown -- never false, which would bar an agent nobody tested.
export function withRunnability(
  detected: readonly DetectedAgent[],
  verdicts: ReadonlyMap<string, { runnable: boolean | null; detail: string }>
): DetectedAgent[] {
  return detected.map((d) => {
    const v = d.found ? verdicts.get(d.id) : undefined;
    if (!v) return d;
    return { ...d, runnable: v.runnable, runnableDetail: v.runnable === false ? v.detail : null };
  });
}

/// Found on PATH and not known to be broken: what the wizard may pick
/// for the human. A CLI that did not answer `--version` is still listed
/// -- they may know why -- but is never chosen for them.
export function usableProfileIds(detected: readonly DetectedAgent[]): string[] {
  return detected.filter((d) => d.found && d.runnable !== false).map((d) => d.id);
}

/// Profile ids found on PATH that did not start.
export function brokenProfileIds(detected: readonly DetectedAgent[]): string[] {
  return detected.filter((d) => d.found && d.runnable === false).map((d) => d.id);
}

/// Profile ids whose default command resolved on PATH.
export function foundProfileIds(detected: readonly DetectedAgent[]): string[] {
  return detected.filter((d) => d.found).map((d) => d.id);
}

/// Whether a profile id was found. Unknown ids (e.g. `custom`) are not.
export function isAgentFound(
  detected: readonly DetectedAgent[],
  profileId: string
): boolean {
  return detected.some((d) => d.id === profileId && d.found);
}

/// Main agent to offer when the wizard has not yet written `[agent].command`.
///
/// Prefer keeping a current profile that is found; else the first found id
/// that already appears in ANY app fallback chain (settings the human
/// already trusts — a non-empty chain for any primary counts); else the
/// first found CLI; else leave current alone. "Found" here is
/// `usableProfileIds`: a CLI found but not runnable is never auto-picked,
/// not even to keep it as the current one.
/// Never overrides once a command is already on disk — that means the
/// human finished this step (or wrote it by hand).
export function suggestMainProfile(input: {
  detected: readonly DetectedAgent[];
  currentProfileId: string | null | undefined;
  appChains: Record<string, readonly string[]> | null | undefined;
  commandAlreadySet: boolean;
}): string | null {
  const current = input.currentProfileId?.trim() || null;
  if (input.commandAlreadySet) return current;

  const found = new Set(usableProfileIds(input.detected));
  if (current && found.has(current)) return current;

  for (const chain of Object.values(input.appChains ?? {})) {
    for (const id of chain) {
      const trimmed = id.trim();
      if (trimmed && found.has(trimmed)) return trimmed;
    }
  }

  const firstFound = usableProfileIds(input.detected)[0] ?? null;
  return firstFound ?? current;
}

/// Fallback chain to seed FOR `mainProfileId` when the app has no chain
/// for that primary yet. An existing chain for it is left alone — the
/// wizard shows found/missing against it rather than rewriting Settings
/// behind the human's back. When seeding from found agents, excludes the
/// main profile so the chain is "who else", not a duplicate of main.
export function suggestFallbackChain(input: {
  detected: readonly DetectedAgent[];
  mainProfileId: string | null | undefined;
  appChains: Record<string, readonly string[]> | null | undefined;
}): string[] | null {
  const main = input.mainProfileId?.trim() || null;
  const existing = (main ? (input.appChains?.[main] ?? []) : []).map((id) => id.trim()).filter(Boolean);
  if (existing.length > 0) return null;

  // Usable ones only, for the primary's reason: a chain seeded with a CLI
  // that does not start is a fallback that fails when it is needed.
  return usableProfileIds(input.detected).filter((id) => id !== main);
}

/// Ids from the main profile's app chain that the sweep did not find —
/// for wizard copy.
export function missingFromAppFallback(
  detected: readonly DetectedAgent[],
  appChains: Record<string, readonly string[]> | null | undefined,
  mainProfileId: string | null | undefined
): string[] {
  const main = mainProfileId?.trim() || null;
  const chain = main ? (appChains?.[main] ?? []) : [];
  const known = new Map(detected.map((d) => [d.id, d.found]));
  const out: string[] = [];
  for (const raw of chain) {
    const id = raw.trim();
    if (!id) continue;
    if (known.get(id) === false) out.push(id);
  }
  return out;
}

/// One line for the wizard: "Found: Claude Code, Cursor Agent" or a
/// sentence when nothing resolves.
export function foundAgentsSummary(detected: readonly DetectedAgent[]): string {
  const usable = detected.filter((d) => d.found && d.runnable !== false).map((d) => d.label);
  const broken = detected.filter((d) => d.found && d.runnable === false).map((d) => d.label);
  if (usable.length === 0 && broken.length === 0) {
    return "None of gavin's built-in agent CLIs were found on PATH.";
  }
  const parts: string[] = [];
  if (usable.length > 0) parts.push(`Found: ${usable.join(", ")}.`);
  if (broken.length > 0) parts.push(`Found but not starting: ${broken.join(", ")}.`);
  return parts.join(" ");
}

/// Deprecation / migration warnings from the PATH sweep (e.g. legacy
/// Gemini CLI without Antigravity).
export function detectWarnings(detected: readonly DetectedAgent[]): string[] {
  const out: string[] = [];
  for (const row of detected) {
    const warning = row.warning?.trim();
    if (warning) out.push(warning);
  }
  return out;
}
