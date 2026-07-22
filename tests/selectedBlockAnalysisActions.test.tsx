/** @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import { useSelectedBlockAnalysisActions } from "../src/renderer/src/hooks/useSelectedBlockAnalysisActions";

describe("selected block analysis actions", () => {
  it("dispatches OCR and translation as separate operations", async () => {
    const block = makeBlock();
    const runBlockOperation = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useSelectedBlockAnalysisActions({
        pushStatus: vi.fn(),
        runBlockOperation,
        selectedPage: makePage(block),
      }),
    );

    await act(() => result.current.ocrSelectedBlock(block.id));
    await act(() => result.current.translateSelectedBlock(block.id));

    expect(runBlockOperation.mock.calls).toEqual([
      [block.bbox, block.id, "ocr"],
      [block.bbox, block.id, "translate"],
    ]);
  });

  it("does not translate a block without source text", async () => {
    const block = { ...makeBlock(), sourceText: "" };
    const pushStatus = vi.fn();
    const runBlockOperation = vi.fn();
    const { result } = renderHook(() =>
      useSelectedBlockAnalysisActions({
        pushStatus,
        runBlockOperation,
        selectedPage: makePage(block),
      }),
    );

    await act(() => result.current.translateSelectedBlock(block.id));

    expect(runBlockOperation).not.toHaveBeenCalled();
    expect(pushStatus).toHaveBeenCalledOnce();
  });
});

function makePage(block: TranslationBlock): MangaPage {
  return {
    id: "page-1",
    name: "001.png",
    imagePath: "/tmp/001.png",
    dataUrl: "",
    width: 1200,
    height: 1600,
    blocks: [block],
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeBlock(): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 300 },
    sourceText: "原文",
    translatedText: "번역",
    confidence: 0.9,
    sourceDirection: "vertical",
    renderDirection: "vertical",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
    autoFitText: true,
  };
}
