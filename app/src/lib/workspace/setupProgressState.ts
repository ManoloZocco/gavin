// The setup progress each workspace's Home tab last worked out, kept
// where the insights publisher (`workspaceInsightsState.ts`) can read it.
//
// `setupProgress` needs file reads, a subprocess and machine readings
// that the Home tab gathers while it is on screen; doing them a second
// time in the background for every open workspace would cost more than
// the answer is worth to an agent. So the tab reports what it settled on,
// and a workspace whose Home tab has not been shown yet has no report --
// which gavin_doctor says, rather than guessing.

import { get, writable } from "svelte/store";
import type { SetupProgress } from "$lib/workspace/setupWizard";

export const reportedSetupProgress = writable<Record<string, SetupProgress>>({});

/// Records a settled reading. A pending one is dropped: it describes the
/// reads that have landed, not the workspace. An unchanged one is dropped
/// too, so the publisher downstream is not woken for nothing.
export function reportSetupProgress(workspaceId: string, progress: SetupProgress): void {
  if (progress.pending) return;
  // Checked before writing: a store emits on every object `set`, even one
  // handed back unchanged.
  const all = get(reportedSetupProgress);
  const before = all[workspaceId];
  if (before && JSON.stringify(before) === JSON.stringify(progress)) return;
  reportedSetupProgress.set({ ...all, [workspaceId]: progress });
}
