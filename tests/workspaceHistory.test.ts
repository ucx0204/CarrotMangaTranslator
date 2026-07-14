import { describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import {
  captureWorkspaceChapterEditSnapshot,
  clearWorkspaceHistory,
  emptyWorkspaceHistory,
  recordWorkspaceHistory,
  replayWorkspaceHistory,
  restoreWorkspaceChapterEditSnapshot,
  type WorkspaceChapterEditHistoryEntry,
  type WorkspaceChapterEditSnapshot,
  type WorkspaceHistoryEntry,
  type WorkspaceImageEditHistoryEntry,
  type WorkspaceMaskEditHistoryEntry,
} from "../src/renderer/src/lib/workspaceHistory";

describe("workspaceHistory", () => {
  it("keeps chapter, mask and image operations in one chronological stack", async () => {
    let state = emptyWorkspaceHistory();
    const entries: WorkspaceHistoryEntry[] = [
      chapterEntry("chapter", 0),
      maskEntry("mask", 1),
      imageEntry("image", 2),
    ];
    for (const entry of entries) {
      state = recordWorkspaceHistory(state, entry).state;
    }

    const applied: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const result = await replayWorkspaceHistory(
        state,
        "undo",
        (entry, direction) => {
          applied.push(`${direction}:${entry.kind}`);
        },
      );
      expect(result).not.toBeNull();
      state = result?.state ?? state;
    }
    expect(applied).toEqual([
      "undo:image-edit",
      "undo:mask-edit",
      "undo:chapter-edit",
    ]);

    const redone = await replayWorkspaceHistory(state, "redo", (entry) => {
      applied.push(`redo:${entry.kind}`);
    });
    expect(redone?.entry.kind).toBe("chapter-edit");
  });

  it("coalesces matching edits for 600ms, preserving first before and last after", () => {
    let state = emptyWorkspaceHistory();
    state = recordWorkspaceHistory(
      state,
      chapterEntry("first", 0, "text:block-1"),
    ).state;
    state = recordWorkspaceHistory(
      state,
      chapterEntry("second", 599, "text:block-1"),
    ).state;

    expect(state.past).toHaveLength(1);
    const coalesced = state.past[0] as WorkspaceChapterEditHistoryEntry;
    expect(coalesced.id).toBe("first");
    expect(coalesced.before.selectedBlockId).toBe("before-first");
    expect(coalesced.after.selectedBlockId).toBe("after-second");

    state = recordWorkspaceHistory(
      state,
      chapterEntry("third", 1199, "text:block-1"),
    ).state;
    expect(state.past).toHaveLength(2);
  });

  it("uses a 60 entry default cap and releases an evicted image revision", () => {
    let state = emptyWorkspaceHistory();
    let released: string[] = [];
    for (let index = 0; index < 61; index += 1) {
      const result = recordWorkspaceHistory(
        state,
        imageEntry(`image-${index}`, index),
      );
      state = result.state;
      released = [...released, ...result.releasedTransactionIds];
    }

    expect(state.past).toHaveLength(60);
    expect(state.past[0].id).toBe("image-1");
    expect(released).toEqual(["transaction-image-0"]);
  });

  it("clears redo on a new operation and releases its image transaction", async () => {
    let state = recordWorkspaceHistory(
      emptyWorkspaceHistory(),
      imageEntry("old-image", 0),
    ).state;
    const undone = await replayWorkspaceHistory(state, "undo", vi.fn());
    state = undone?.state ?? state;

    const recorded = recordWorkspaceHistory(
      state,
      chapterEntry("replacement", 10),
    );
    expect(recorded.state.future).toHaveLength(0);
    expect(recorded.releasedTransactionIds).toEqual(["transaction-old-image"]);
  });

  it("does not move a stack when asynchronous replay fails", async () => {
    const state = recordWorkspaceHistory(
      emptyWorkspaceHistory(),
      imageEntry("failed", 0),
    ).state;

    await expect(
      replayWorkspaceHistory(state, "undo", () =>
        Promise.reject(new Error("transaction conflict")),
      ),
    ).rejects.toThrow("transaction conflict");
    expect(state.past).toHaveLength(1);
    expect(state.future).toHaveLength(0);
  });

  it("drops only an invalidated replay instead of moving it across stacks", async () => {
    const older = chapterEntry("older", 0);
    const invalidated = imageEntry("invalidated", 1);
    const undoState = {
      past: [older, invalidated],
      future: [] as WorkspaceHistoryEntry[],
    };

    const undone = await replayWorkspaceHistory(
      undoState,
      "undo",
      () => "invalidated",
    );
    expect(undone?.outcome).toBe("invalidated");
    expect(undone?.state.past).toEqual([older]);
    expect(undone?.state.future).toEqual([]);

    const redoState = {
      past: [older],
      future: [invalidated],
    };
    const redone = await replayWorkspaceHistory(
      redoState,
      "redo",
      () => "invalidated",
    );
    expect(redone?.state.past).toEqual([older]);
    expect(redone?.state.future).toEqual([]);
  });

  it("reports every image transaction when a session is cleared", () => {
    const first = recordWorkspaceHistory(
      emptyWorkspaceHistory(),
      imageEntry("one", 0),
    ).state;
    const second = recordWorkspaceHistory(first, imageEntry("two", 1)).state;

    const cleared = clearWorkspaceHistory(second);
    expect(cleared.state).toEqual({ past: [], future: [] });
    expect(cleared.releasedTransactionIds).toEqual([
      "transaction-one",
      "transaction-two",
    ]);
  });

  it("restores blocks and selection without reverting image or analysis metadata", () => {
    const chapter = makeChapter("new image", [makeBlock("new text")]);
    const before = makeChapter("old image", [makeBlock("old text")]);
    const snapshot = captureWorkspaceChapterEditSnapshot(before, {
      selectedPageId: "page-1",
      selectedBlockId: "block-1",
      selectedBlockIds: ["block-1"],
    });

    const restored = restoreWorkspaceChapterEditSnapshot(chapter, snapshot);
    expect(restored.pages[0].blocks[0].translatedText).toBe("old text");
    expect(restored.pages[0].inpaintedImagePath).toBe("new image");
    expect(restored.pages[0].analysisStatus).toBe("running");
  });

  it("rejects a block snapshot from a different chapter", () => {
    const chapter = makeChapter("image", []);
    const snapshot = chapterSnapshot("different");
    snapshot.chapterId = "another-chapter";
    expect(() =>
      restoreWorkspaceChapterEditSnapshot(chapter, snapshot),
    ).toThrow("chapter mismatch");
  });
});

function chapterEntry(
  id: string,
  time: number,
  mergeKey?: string,
): WorkspaceChapterEditHistoryEntry {
  return {
    kind: "chapter-edit",
    id,
    label: `chapter ${id}`,
    mergeKey,
    time,
    before: chapterSnapshot(`before-${id}`),
    after: chapterSnapshot(`after-${id}`),
  };
}

function maskEntry(id: string, time: number): WorkspaceMaskEditHistoryEntry {
  return {
    kind: "mask-edit",
    id,
    label: `mask ${id}`,
    time,
    before: { chapterId: "chapter-1", pageId: "page-1", strokes: [] },
    after: {
      chapterId: "chapter-1",
      pageId: "page-1",
      strokes: [{ points: [{ x: 1, y: 2 }], radiusPx: 10 }],
    },
  };
}

function imageEntry(id: string, time: number): WorkspaceImageEditHistoryEntry {
  return {
    kind: "image-edit",
    id,
    label: `image ${id}`,
    time,
    transactionId: `transaction-${id}`,
  };
}

function chapterSnapshot(
  selectedBlockId: string,
): WorkspaceChapterEditSnapshot {
  return {
    chapterId: "chapter-1",
    pages: [],
    selectedPageId: "page-1",
    selectedBlockId,
    selectedBlockIds: selectedBlockId ? [selectedBlockId] : [],
  };
}

function makeChapter(
  inpaintedImagePath: string,
  blocks: TranslationBlock[],
): ChapterSnapshot {
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "Chapter",
    sourceKind: "images",
    status: "completed",
    pageOrder: ["page-1"],
    pages: [
      {
        id: "page-1",
        name: "001.png",
        imagePath: "original.png",
        inpaintedImagePath,
        dataUrl: "data:image/png;base64,",
        width: 100,
        height: 100,
        blocks,
        analysisStatus: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeBlock(translatedText: string): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 0, y: 0, w: 100, h: 100 },
    sourceText: "source",
    translatedText,
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 20,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#000000",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}
