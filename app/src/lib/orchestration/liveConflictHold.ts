// The one exception to spec O4 ("gavin never blocks a run because of a
// conflict"), and only where a rail asks for it.
//
// O4 stays the rule: conflicts are evidence, drawn in the box and on the
// chips, and the scheduler never reads them. The owner decided one
// opt-in exception (lc-06, option A: per rail, off by default): a rail
// may ask that, while a LIVE same-worktree conflict stands in its
// checkout -- two or more agents running in it right now, on other rails
// -- its next stage waits instead of adding agents to the pile, until
// the human confirms it may go.
//
// Per rail rather than per workspace because the hazard is about one
// checkout and the work on it: a rail of small tool steps sharing the
// root with a long refactor has every reason to wait, and the refactor's
// own rail has none. Reversible because it is only ever a WAIT -- nothing
// is cancelled, and a confirmation releases it.
//
// NOT WIRED. The opt-in needs a persisted rail field the daemon does not
// store yet: `Rail.holdOnLiveConflict` (`crates/daemon/src/orchestration.rs`
// and the protocol's rail type, with a `FEATURE_MIN_VERSION` entry in
// `daemonCompat.ts` and a `featureBlockedReason` consumer on the rail
// settings surface that sets it, per CLAUDE.md's compat-gate rule).
// Until then no rail can carry `true`, and nothing calls this: the
// scheduler (`nextActions` in orchestration.ts) would consult it where it
// decides a stage's steps may launch, and treat a hold as it treats a
// stall -- the step stays pending with the reason on its chip.
// Acknowledgement would be per window, like the conflicts box's dismissals.
//
// Pure: the conflicts come from `detectConflicts`, computed by the caller.

import type { Conflict } from "$lib/orchestration/orchestration";

/// The rail's side of the question: its id, its steps, and the opt-in.
/// `holdOnLiveConflict` is optional because no rail persists it yet (see
/// above) -- absent reads as false, which is O4.
export interface HoldingRail {
  id: string;
  stages: { steps: { id: string }[] }[];
  holdOnLiveConflict?: boolean;
}

type SameWorktree = Extract<Conflict, { kind: "same-worktree" }>;

export type LiveConflictHold =
  | { hold: false }
  | {
      hold: true;
      /// The conflict holding it, so the chip can carry its badge number.
      conflict: SameWorktree;
      /// The key a confirmation is recorded under (`liveConflictKey`).
      key: string;
      /// The sentence for the step chip.
      reason: string;
    };

/// One live conflict's identity for a confirmation: the checkout and the
/// steps in it. A confirmation answers the collision the human SAW; a
/// third agent joining the checkout is a different collision and asks
/// again.
export function liveConflictKey(c: SameWorktree): string {
  return `${c.worktreePath}\u0000${[...c.stepIds].sort().join(",")}`;
}

/// Whether the scheduler should hold `rail`'s next stage, given the
/// conflicts as `detectConflicts` computed them.
///
/// Holds only when every one of these is true:
///  - the rail opted in (`holdOnLiveConflict`);
///  - a `same-worktree` conflict is LIVE -- at least two of its steps
///    running now (`severityOf`), never a merely potential one;
///  - it is about this rail's checkout: it names one of this rail's
///    steps AND a step of another rail. A parallel stage on this rail is
///    two agents in one checkout by the human's own design, and the next
///    stage waits for it anyway; holding on that would be the rail
///    waiting on itself;
///  - the human has not confirmed that exact conflict (`acknowledged`).
///
/// The first matching conflict wins: one reason on a chip is readable,
/// and confirming it reveals the next if there is one.
export function liveConflictHold(
  rail: HoldingRail,
  conflicts: readonly Conflict[],
  acknowledged: ReadonlySet<string> = new Set()
): LiveConflictHold {
  if (rail.holdOnLiveConflict !== true) return { hold: false };
  const own = new Set(rail.stages.flatMap((s) => s.steps.map((t) => t.id)));
  for (const c of conflicts) {
    if (c.kind !== "same-worktree" || c.severity !== "live") continue;
    const mine = c.stepIds.filter((id) => own.has(id));
    const theirs = c.stepIds.length - mine.length;
    if (mine.length === 0 || theirs === 0) continue;
    const key = liveConflictKey(c);
    if (acknowledged.has(key)) continue;
    return {
      hold: true,
      conflict: c,
      key,
      reason:
        `Waiting: other rails have agents running in this checkout right now. ` +
        `Confirm to start the next stage beside them.`,
    };
  }
  return { hold: false };
}
