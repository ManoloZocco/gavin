// Which sessions are agents running without their gavin_* tools, by
// session id. The rules are in toolsMissing.ts; the remedy is
// toolsMissingRepair.ts.
//
// Two writers, one per way the fact arrives, the shape headroomMarkState
// has for the same reason:
//
// - `noteToolsMissing`, from the host's `session-tools-missing` event --
//   the daemon's push when the grace runs out, and again when a late
//   Hello clears it.
// - `seedToolsMissing`, from the session baselines a frontend reads when
//   it loads or reloads: the push arrived once per app process, and a
//   reload missed it.
//
// A leaf: it imports nothing of the app's state, so layoutState can
// import it statically.

import { writable } from "svelte/store";
import { parseToolsMissing } from "$lib/agents/toolsMissing";

/// Only marked sessions are present: an absent id is no mark.
export const toolsMissingById = writable<Record<string, true>>({});

/// What the daemon pushed about one session. The newest word there is.
export function noteToolsMissing(sessionId: string, missing: unknown): void {
  toolsMissingById.update((all) => {
    const marked = parseToolsMissing(missing);
    if (marked === (all[sessionId] === true)) return all;
    const next = { ...all };
    if (marked) next[sessionId] = true;
    else delete next[sessionId];
    return next;
  });
}

/// What the baselines say about sessions this frontend has no word on
/// yet. Never over an entry that is already here -- a push that landed is
/// newer than this snapshot -- and a baseline only ever ADDS a mark: an
/// absent one is "no mark" or "an older host", and neither should clear
/// what a push said.
export function seedToolsMissing(baselines: readonly { id: string; toolsMissing?: unknown }[]): void {
  toolsMissingById.update((all) => {
    const fresh = baselines.filter((b) => all[b.id] === undefined && parseToolsMissing(b.toolsMissing));
    if (fresh.length === 0) return all;
    const next = { ...all };
    for (const b of fresh) next[b.id] = true;
    return next;
  });
}

/// @internal - for testing only
export function __resetForTesting(): void {
  toolsMissingById.set({});
}
