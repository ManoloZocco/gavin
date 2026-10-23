import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  __resetForTesting,
  noteToolsMissing,
  seedToolsMissing,
  toolsMissingById,
} from "$lib/agents/toolsMissingState";

beforeEach(() => __resetForTesting());

describe("the daemon's push", () => {
  it("marks a session, and a late Hello clears it", () => {
    noteToolsMissing("s1", true);
    expect(get(toolsMissingById)).toEqual({ s1: true });
    noteToolsMissing("s1", false);
    expect(get(toolsMissingById)).toEqual({});
  });

  it("changes nothing when it says what is already known", () => {
    noteToolsMissing("s1", true);
    const before = get(toolsMissingById);
    noteToolsMissing("s1", true);
    expect(get(toolsMissingById)).toBe(before);
    noteToolsMissing("s2", false);
    expect(get(toolsMissingById)).toBe(before);
  });
});

describe("the baselines a reload reads", () => {
  it("bring back the marks a reload missed, and only the marks", () => {
    seedToolsMissing([
      { id: "s1", toolsMissing: true },
      { id: "s2", toolsMissing: false },
      // An older host sends no field at all.
      { id: "s3" },
    ]);
    expect(get(toolsMissingById)).toEqual({ s1: true });
  });

  it("never clears a mark a push already set", () => {
    noteToolsMissing("s1", true);
    seedToolsMissing([{ id: "s1", toolsMissing: false }]);
    expect(get(toolsMissingById)).toEqual({ s1: true });
  });
});
