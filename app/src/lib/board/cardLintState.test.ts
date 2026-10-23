import { describe, it, expect, vi } from "vitest";
import { get } from "svelte/store";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("$lib/core/backend", () => ({}));

import { cardLint } from "$lib/board/cardLintState";
import { gavinTrees } from "$lib/core/gavinState";
import { kanbanState } from "$lib/board/kanbanState";
import type { Board } from "$lib/board/kanban";
import type { GavinTree } from "$lib/core/gavin";

const PATH = "/ws/.gavin-root/plans/a.md";

function tree(status: string): GavinTree {
  return {
    rootPath: "/ws",
    rootMissing: false,
    contexts: [
      {
        folderPath: "/ws",
        kind: "root",
        name: "root",
        plans: [
          {
            path: PATH,
            fileName: "a.md",
            title: "a",
            status,
            priority: null,
            order: null,
            kind: "plan",
            parent: null,
            labels: [],
            checklistDone: 0,
            checklistTotal: 0,
            parseWarning: false,
          },
        ],
        docs: [],
        specs: [],
        hasPrd: false,
        configWarning: false,
      },
    ],
  };
}

const board: Board = {
  columns: [
    { id: "c1", name: "To Do", position: 0 },
    { id: "c3", name: "Done", position: 1 },
    { id: "c4", name: "Shipped", position: 2 },
  ],
  labels: [],
  cardSessions: [],
};

describe("cardLint store", () => {
  it("indexes each workspace's findings, re-linting only what changed", () => {
    gavinTrees.set({ w1: tree("Nope"), w2: tree("To Do") });
    kanbanState.set({ w1: board, w2: board });
    const first = get(cardLint);
    expect(first.w1.byPath.get(PATH)?.map((f) => f.code)).toEqual(["status-unknown"]);
    expect(first.w1.byColumn.get("c4")?.map((f) => f.code)).toEqual(["column-right-of-done"]);
    expect(first.w2.byPath.size).toBe(0);

    // A push that replaces only w1's tree leaves w2's index the same object.
    gavinTrees.update((t) => ({ ...t, w1: tree("To Do") }));
    const second = get(cardLint);
    expect(second.w1.byPath.size).toBe(0);
    expect(second.w2).toBe(first.w2);

    gavinTrees.set({});
    kanbanState.set({});
    expect(get(cardLint)).toEqual({});
  });
});
