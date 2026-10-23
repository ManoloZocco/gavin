// The prerequisite check's answer, shared by every surface that reads it.
//
// One ask per window: the Home notice, Settings' Prerequisites panel and
// the wizard's Agent step all read this store, so the agent CLIs are
// started once rather than once per surface. Asked by the first surface
// that mounts -- in practice the Home tab a window opens on -- and not
// from `bootstrap`, which a Companion's Demo Workstation is held to
// answering in full; a Device asking the desk's prerequisites is a
// surface asking, the same as here. "Check again" asks anew.
//
// What the answer means is `prerequisites.ts`'s.

import { writable, type Readable } from "svelte/store";
import * as backend from "$lib/core/backend";
import type { PreflightItem } from "$lib/agents/prerequisites";

export type PreflightReading =
  | { kind: "items"; items: PreflightItem[] }
  /// The ask failed. Settled, so nothing waits on it for ever.
  | { kind: "error"; message: string };

const reading = writable<PreflightReading | undefined>(undefined);
const checking = writable(false);

/// The answer, `undefined` until the first one lands.
export const preflightReading: Readable<PreflightReading | undefined> = { subscribe: reading.subscribe };
/// Whether an ask is out.
export const preflightChecking: Readable<boolean> = { subscribe: checking.subscribe };

/// Bumped by every ask, so an answer that lands after a newer one was
/// asked for is dropped (CLAUDE.md: guard async supersession with a
/// token, never with identity).
let token = 0;
let asked = false;

export async function refreshPreflight(): Promise<void> {
  asked = true;
  const mine = ++token;
  checking.set(true);
  let next: PreflightReading;
  try {
    next = { kind: "items", items: await backend.preflight() };
  } catch (e) {
    next = { kind: "error", message: String(e instanceof Error ? e.message : e) };
  }
  if (mine !== token) return;
  reading.set(next);
  checking.set(false);
}

/// Asks once per window; later calls are free.
export function ensurePreflight(): void {
  if (asked) return;
  void refreshPreflight();
}

/// The items, or an empty list while unknown or failed.
export function preflightItems(r: PreflightReading | undefined): PreflightItem[] {
  return r?.kind === "items" ? r.items : [];
}
