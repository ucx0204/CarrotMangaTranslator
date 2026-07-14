/** @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import type { GatheredPage } from "../src/renderer/src/lib/gatherText";
import { useGatherTextFormatSelection } from "../src/renderer/src/components/gatherText/useGatherTextFormatSelection";

const TS = "2026-01-01T00:00:00.000Z";
const pages: GatheredPage[] = [
  {
    pageId: "p1",
    pageName: "1.png",
    index: 0,
    blocks: [
      { id: "same", sourceText: "a", translatedText: "A" },
      { id: "next", sourceText: "b", translatedText: "B" },
    ],
  },
  {
    pageId: "p2",
    pageName: "2.png",
    index: 1,
    blocks: [{ id: "same", sourceText: "c", translatedText: "C" }],
  },
];

describe("useGatherTextFormatSelection", () => {
  it("starts compact and clears the selected blocks on exit", () => {
    const { result } = renderSelection();
    const first = { pageId: "p1", blockId: "same" };

    expect(result.current?.isSelectionMode).toBe(false);
    act(() => result.current?.enterSelectionMode());
    act(() => result.current?.toggle(first));
    expect(result.current?.isSelectionMode).toBe(true);
    expect(result.current?.selectedCount).toBe(1);

    act(() => result.current?.exitSelectionMode());
    expect(result.current?.isSelectionMode).toBe(false);
    expect(result.current?.selectedCount).toBe(0);
  });

  it("uses composite refs and applies a direct patch to every selected block", () => {
    const onApply = vi.fn();
    const { result } = renderSelection(onApply);
    const first = { pageId: "p1", blockId: "same" };
    const duplicate = { pageId: "p2", blockId: "same" };

    act(() => result.current?.toggle(first));
    act(() => result.current?.toggle(duplicate));
    act(() => result.current?.openFormatModal());
    expect(result.current?.isFormatModalOpen).toBe(true);

    act(() => result.current?.apply({ fontSizePx: 31, bold: true }));
    expect(onApply).toHaveBeenCalledWith({
      targets: [first, duplicate],
      patch: { fontSizePx: 31, bold: true },
    });
    expect(result.current?.isFormatModalOpen).toBe(false);
    expect(result.current?.selectedCount).toBe(2);
  });

  it("derives mixed and common values from the selected blocks", () => {
    const chapter = makeChapter();
    const { result } = renderSelection(vi.fn(), chapter);

    act(() => result.current?.toggle({ pageId: "p1", blockId: "same" }));
    act(() => result.current?.toggle({ pageId: "p1", blockId: "next" }));

    expect(result.current?.formatModel.selectionCount).toBe(2);
    expect(result.current?.formatModel.values.fontSizePx).toEqual({
      kind: "mixed",
    });
    expect(result.current?.formatModel.values.textAlign).toEqual({
      kind: "common",
      value: "center",
    });
  });

  it("reconciles selected refs when filtered blocks disappear", () => {
    const onApply = vi.fn();
    const { result, rerender } = renderHook(
      ({ currentPages }: { currentPages: GatheredPage[] }) =>
        useGatherTextFormatSelection({
          chapter: null,
          disabled: false,
          onApply,
          pages: currentPages,
        }),
      { initialProps: { currentPages: pages } },
    );

    act(() => result.current?.selectAllVisible());
    expect(result.current?.selectedCount).toBe(3);

    rerender({ currentPages: [pages[1]] });
    expect(result.current?.selectedCount).toBe(1);
    expect(result.current?.isSelected({ pageId: "p2", blockId: "same" })).toBe(
      true,
    );
  });
});

function renderSelection(
  onApply = vi.fn(),
  chapter: ChapterSnapshot | null = null,
) {
  return renderHook(() =>
    useGatherTextFormatSelection({
      chapter,
      disabled: false,
      onApply,
      pages,
    }),
  );
}

function makeChapter(): ChapterSnapshot {
  const page: MangaPage = {
    id: "p1",
    name: "1.png",
    imagePath: "1.png",
    dataUrl: "",
    width: 100,
    height: 100,
    blocks: [makeBlock("same", 24), makeBlock("next", 36)],
    analysisStatus: "completed",
    createdAt: TS,
    updatedAt: TS,
  };
  return {
    id: "chapter",
    workId: "work",
    title: "Chapter",
    sourceKind: "images",
    status: "completed",
    pageOrder: [page.id],
    pages: [page],
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeBlock(id: string, fontSizePx: number): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox: { x: 1, y: 2, w: 3, h: 4 },
    sourceText: id,
    translatedText: id,
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "transparent",
    opacity: 1,
  };
}
