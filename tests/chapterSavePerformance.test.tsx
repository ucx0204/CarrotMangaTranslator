/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useQueuedChapterSave } from "../src/renderer/src/hooks/useQueuedChapterSave";
import { useChapterPersistenceRefs } from "../src/renderer/src/hooks/useChapterPersistenceRefs";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each([30, 500])(
  "measures a %i-page save acknowledgement without intervening edits",
  async (count) => {
    const chapter: ChapterSnapshot = {
      id: "chapter",
      workId: "work",
      title: "Benchmark",
      sourceKind: "images",
      status: "idle",
      pageOrder: [],
      createdAt: "",
      updatedAt: "",
      pages: Array.from({ length: count }, (_, i) => ({
        id: `page-${i}`,
        name: `${i}.png`,
        imagePath: `${i}.png`,
        dataUrl: "",
        width: 1000,
        height: 1500,
        analysisStatus: "idle",
        createdAt: "",
        updatedAt: "",
        blocks: Array.from({ length: 20 }, (_, j) => ({
          id: `block-${j}`,
          type: "nonsolid",
          confidence: 1,
          sourceDirection: "vertical",
          renderDirection: "horizontal",
          fontSizePx: 18,
          lineHeight: 1.2,
          textAlign: "center",
          textColor: "#111111",
          backgroundColor: "#ffffff",
          opacity: 0.8,
          sourceText: "Original text ".repeat(10),
          translatedText: "번역할 문장입니다. ".repeat(10),
          bbox: { x: 100, y: 100, w: 200, h: 200 },
        })),
      })),
    };
    chapter.pageOrder = chapter.pages.map((p) => p.id);
    const currentChapterRef = { current: chapter as ChapterSnapshot | null };
    const saved = structuredClone(chapter);
    saved.pages.forEach((p) => {
      p.updatedAt = "saved";
    });
    const persistChapter = vi.fn(async () => saved);
    const setCurrentChapter = vi.fn();
    const syncServerPageVersions = vi.fn();
    const view = renderHook(() => {
      const refs = useChapterPersistenceRefs();
      const save = useQueuedChapterSave({
        currentChapterRef,
        persistChapter,
        refs,
        setCurrentChapter,
        setDirty: vi.fn(),
        syncServerPageVersions,
      });
      return { refs, save };
    });
    view.result.current.refs.dirtyPageIdsRef.current = new Set(
      chapter.pageOrder,
    );
    let sourceBlockReads = 0;
    for (const page of chapter.pages) {
      const blocks = page.blocks;
      Object.defineProperty(page, "blocks", {
        get: () => {
          sourceBlockReads++;
          return blocks;
        },
      });
    }
    const started = performance.now();
    await act(() => view.result.current.save("manual"));
    process.stdout.write(
      `save acknowledgement: ${count} pages, ${(performance.now() - started).toFixed(1)}ms` +
        "\n",
    );
    expect(sourceBlockReads).toBe(0);
    expect(persistChapter).toHaveBeenCalledOnce();
    expect(view.result.current.refs.dirtyPageIdsRef.current.size).toBe(0);
    expect(
      currentChapterRef.current?.pages.every((p) => p.updatedAt === "saved"),
    ).toBe(true);
  },
);
