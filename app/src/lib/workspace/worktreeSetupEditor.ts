/// The `[worktree] setup` editor in the workspace Settings: what the
/// textarea holds, whether it can be saved, and what a save does to the
/// workspace-trust marker. `WorktreeSetupPanel.svelte` is a thin template
/// over this.
///
/// The daemon is the authority on what a line may be
/// (`gavin::set_worktree_setup`); the limits below mirror it only so the
/// editor can say what is wrong before a round trip. A change to one owes
/// the other.
import { executionKeysHash, hasExecutionKeys, type ExecutionKeys } from "$lib/workspace/workspaceTrust";
import type { ProposedSetupLine } from "$lib/workspace/worktreeSetupDetect";

/// `MAX_WORKTREE_SETUP_LINES` in crates/daemon/src/gavin.rs.
export const MAX_SETUP_LINES = 32;
/// `MAX_WORKTREE_SETUP_LINE_BYTES` in crates/daemon/src/gavin.rs.
export const MAX_SETUP_LINE_BYTES = 1024;

/// The declared lines as the editor shows them: one command per line.
export function editorText(lines: readonly string[]): string {
  return lines.join("\n");
}

/// What the editor's text would store: one command per line, trimmed,
/// blank lines dropped. Blank lines are dropped rather than refused here
/// because in a textarea they are spacing, not commands — the stored
/// value is exactly what the human sees minus the spacing.
export function editorLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/// Why these lines cannot be saved, or null. Control characters other
/// than tab are invisible on the approval sheet, and the daemon refuses
/// them; a line break cannot occur here, the split above consumed it.
export function editorProblem(lines: readonly string[]): string | null {
  if (lines.length > MAX_SETUP_LINES) {
    return `At most ${MAX_SETUP_LINES} lines; this has ${lines.length}.`;
  }
  for (const [i, line] of lines.entries()) {
    if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(line)) {
      return `Line ${i + 1} holds a control character.`;
    }
    const bytes = utf8Bytes(line);
    if (bytes > MAX_SETUP_LINE_BYTES) {
      return `Line ${i + 1} is ${bytes} bytes; the limit is ${MAX_SETUP_LINE_BYTES}.`;
    }
  }
  return null;
}

/// Whether the text differs from what config.toml declares — the Save
/// button's condition, beside `editorProblem`.
export function editorDirty(text: string, declared: readonly string[]): boolean {
  const lines = editorLines(text);
  return lines.length !== declared.length || lines.some((l, i) => l !== declared[i]);
}

/// The editor's text after config.toml's declared value moved from
/// `previous` to `next` (a watcher push: the human's own save, an agent's
/// proposal, a `git pull`). Untouched text follows the file; text the
/// human has edited is kept, so a push never eats what they are typing.
/// `previous` is null before the first value arrives.
export function reseededDraft(draft: string, previous: string | null, next: string): string {
  if (previous === null) return next;
  return editorDirty(draft, editorLines(previous)) ? draft : next;
}

/// "Use proposal": the detected lines, in proposal order, as editor text.
/// Fills the editor only; nothing is written until Save.
export function proposalText(proposal: readonly ProposedSetupLine[]): string {
  return editorText(proposal.map((p) => p.line));
}

/// What a human Save does to the trust marker, given where trust stood
/// just BEFORE the save and the lines saved.
///
/// - `{ stamp: hash }` — record the new digest (`undefined` clears the
///   marker, for a config left with nothing executable).
/// - `null` — leave the marker alone, so the trust notice asks.
///
/// The Save IS the human approving their own lines, the way a Settings
/// write of `[agent] command` is (`setAgentField`). But the digest covers
/// all three execution keys at once, so re-stamping also approves
/// whatever `[agent] command` and `[agent] file` hold — values this
/// editor never showed. It therefore stamps only when that approves
/// nothing unseen: the config was already approved before the save, or
/// it names no command or file at all. Otherwise the notice above the
/// editor keeps asking, with every value listed on its sheet.
///
/// Computed from the saved lines laid over the keys as they stood, not
/// from the store: the watcher push carrying the new value has not
/// landed yet, and hashing the old lines would approve something nobody
/// asked for.
export function setupSaveStamp(
  before: { keys: ExecutionKeys; trusted: boolean },
  saved: readonly string[]
): { stamp: string | undefined } | null {
  const othersUnseen = before.keys.command !== "" || before.keys.file !== "";
  if (!before.trusted && othersUnseen) return null;
  const keys: ExecutionKeys = { ...before.keys, setup: [...saved] };
  return { stamp: hasExecutionKeys(keys) ? executionKeysHash(keys) : undefined };
}

/// The line under Save once it has answered.
export function saveNote(result: { written: boolean; lines: readonly string[] }, stamped: boolean): string {
  if (!result.written) return "Nothing to save: config.toml already declares exactly these lines.";
  if (result.lines.length === 0) return "Saved: no [worktree] setup is declared now.";
  return stamped
    ? "Saved and approved: these run in every new worktree, before its agent starts."
    : "Saved. Approve this repo's config.toml commands above before gavin runs them.";
}
