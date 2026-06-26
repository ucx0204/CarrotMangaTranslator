import { describe, expect, it } from "vitest";
import {
  emptyHistory,
  recordHistory,
  redoHistory,
  undoHistory,
  type ChapterHistoryEntry,
} from "../src/renderer/src/lib/chapterHistoryStack";

type Chapter = { value: string };

function entry(
  value: string,
  time: number,
  mergeKey?: string,
): ChapterHistoryEntry<Chapter> {
  return {
    chapter: { value },
    selectedPageId: null,
    selectedBlockId: null,
    selectedBlockIds: [],
    mergeKey,
    time,
  };
}

describe("chapterHistoryStack", () => {
  it("records distinct edits as separate undo steps and clears redo", () => {
    let state = emptyHistory<Chapter>();
    state = recordHistory(state, entry("a", 0));
    state = recordHistory(state, entry("b", 1000));
    expect(state.past).toHaveLength(2);
    expect(state.future).toHaveLength(0);
  });

  it("coalesces same-mergeKey edits inside the window into one step", () => {
    let state = emptyHistory<Chapter>();
    state = recordHistory(state, entry("a", 0, "text:1"), {
      mergeKey: "text:1",
    });
    state = recordHistory(state, entry("ab", 100, "text:1"), {
      mergeKey: "text:1",
    });
    state = recordHistory(state, entry("abc", 200, "text:1"), {
      mergeKey: "text:1",
    });
    expect(state.past).toHaveLength(1);
    // The preserved "before" snapshot is the earliest one.
    expect(state.past[0].chapter.value).toBe("a");
  });

  it("does not coalesce once the window has elapsed", () => {
    let state = emptyHistory<Chapter>();
    state = recordHistory(state, entry("a", 0, "text:1"), {
      mergeKey: "text:1",
    });
    state = recordHistory(state, entry("b", 5000, "text:1"), {
      mergeKey: "text:1",
    });
    expect(state.past).toHaveLength(2);
  });

  it("undo moves the prior snapshot out and pushes the present onto redo", () => {
    let state = emptyHistory<Chapter>();
    state = recordHistory(state, entry("before", 0));
    const result = undoHistory(state, entry("after", 10));
    expect(result).not.toBeNull();
    expect(result?.entry.chapter.value).toBe("before");
    expect(result?.state.past).toHaveLength(0);
    expect(result?.state.future).toHaveLength(1);
    expect(result?.state.future[0].chapter.value).toBe("after");
  });

  it("redo replays the undone snapshot", () => {
    let state = emptyHistory<Chapter>();
    state = recordHistory(state, entry("before", 0));
    const undone = undoHistory(state, entry("after", 10));
    if (!undone) {
      throw new Error("expected an undo result");
    }
    const redone = redoHistory(undone.state, entry("before", 20));
    expect(redone?.entry.chapter.value).toBe("after");
    expect(redone?.state.future).toHaveLength(0);
    expect(redone?.state.past).toHaveLength(1);
  });

  it("returns null when there is nothing to undo or redo", () => {
    const state = emptyHistory<Chapter>();
    expect(undoHistory(state, entry("x", 0))).toBeNull();
    expect(redoHistory(state, entry("x", 0))).toBeNull();
  });

  it("caps history at the configured maximum", () => {
    let state = emptyHistory<Chapter>();
    for (let i = 0; i < 10; i += 1) {
      state = recordHistory(state, entry(String(i), i * 1000), {
        maxEntries: 5,
      });
    }
    expect(state.past).toHaveLength(5);
    expect(state.past[0].chapter.value).toBe("5");
  });
});
