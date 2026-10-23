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
// Wired since v81. The opt-in is the persisted rail field
// `Rail.holdOnLiveConflict` (`crates/daemon/src/orchestration.rs` and the
// protocol's rail type), gated by `FEATURE_MIN_VERSION.liveConflictHold`
// in `daemonCompat.ts`, whose consumer is the rail header's toggle -- an
// older daemon drops the field, and the opt-in would silently never
// stick. The scheduler (`nextActions` in orchestration.ts, rule 2) asks
// this where it decides a pending step may launch and treats a hold as a
// stall: the step does not launch, its rail pauses, and the step carries
// this module's reason, which `stepAttentions` marks `live-conflict` --
// "needs you". Confirming it (`retryStep` in orchestrationState.ts) adds
// the conflict's key to that window's acknowledged set and resumes the
// rail. Per window, like the conflicts box's dismissals: a confirmation
// answers what this human saw here.
//
// Pure: the conflicts come from `detectConflicts`, computed by the caller.

import type { Conflict } from "$lib/orchestration/orchestration";

/// The rail's side of the question: its id, its steps, and the opt-in.
/// `holdOnLiveConflict` is optional because no rail written before v81
/// carries it -- absent (or null) reads as false, which is O4.
export interface HoldingRail {
  id: string;
  stages: { steps: { id: string }[] }[];
  holdOnLiveConflict?: boolean | null;
}

/// The sentence a held step stalls with. One constant, because the stall
/// reason is the only place the hold is written down: `stepAttentions`
/// matches it to raise the "needs you" mark, and `retryStep` matches it to
/// know a Retry is a confirmation -- a field on StepRun would be a
/// protocol bump for a fact the app already knows, the reasoning
/// `isUnreviewedStall` follows.
export const LIVE_CONFLICT_HOLD_REASON =
  "Waiting: other rails have agents running in this checkout right now. " +
  "Confirm to start the next stage beside them.";

/// Whether a stalled step is held by this rule rather than broken.
export function isLiveConflictHoldStall(reason: string | null | undefined): boolean {
  return reason === LIVE_CONFLICT_HOLD_REASON;
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
    return { hold: true, conflict: c, key, reason: LIVE_CONFLICT_HOLD_REASON };
  }
  return { hold: false };
}
