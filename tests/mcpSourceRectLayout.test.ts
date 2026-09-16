/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyMcpSourceRect } from "../src/main/application/mcpSourceRectPolicy";
import { resolveBlockTextLayout } from "../src/renderer/src/lib/overlayLayout";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import { clearSourceFontFaceRatioCache } from "../src/renderer/src/lib/sourceFontSizeMatching";
import { editingChapter } from "./mcpEditing.fixture";

beforeEach(() => {
  clearSourceFontFaceRatioCache();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "",
    measureText(this: { font: string }, text: string) {
      const size = Number(/([\d.]+)px/.exec(this.font)?.[1] ?? 16);
      return {
        width: Array.from(text).length * size,
        actualBoundingBoxAscent: size * 0.8,
        actualBoundingBoxDescent: size * 0.2,
        actualBoundingBoxLeft: size * 0.5,
        actualBoundingBoxRight: size * 0.5,
      };
    },
  } as CanvasRenderingContext2D);
});
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const page = editingChapter().pages[0];
  const block = page.blocks[0];
  delete block.generatedLettering;
  block.bbox = { x: 100, y: 100, w: 300, h: 300 };
  block.bboxSpace = "pixels";
  block.renderBbox = { ...block.bbox };
  block.renderBboxSpace = "pixels";
  block.fontFamily = "noto-sans-kr";
  block.sourceText = "ABCDEFGHIJKLMNO";
  block.translatedText = "Keep this text";
  const request = {
    chapterId: "chapter",
    pageId: "page",
    blockId: "a",
    revision: "page-v1:0000000000000000",
    sourceRect: { x: 100, y: 100, w: 30, h: 30 },
  };
  const layout = (value: typeof block) =>
    resolveBlockTextLayout(
      value,
      value.translatedText,
      page,
      page,
      DEFAULT_BLOCK_FONT_CATALOG,
    );
  return { page, block, request, layout };
}

it.each([true, false])(
  "preserves actual text layout with explicit frame=%s",
  (explicit) => {
    const f = fixture();
    if (!explicit) delete f.block.renderBbox;
    const before = f.layout(f.block);
    const changed = applyMcpSourceRect(f.page, f.request).blocks[0];
    expect(f.layout(changed)).toEqual(before);
    expect(changed.fontSizePx).toBe(f.block.fontSizePx);
    expect(changed.translatedText).toBe(f.block.translatedText);
  },
);

it("rejects geometry-dependent generated font layout rather than silently changing its size", () => {
  const f = fixture();
  Object.assign(f.block, {
    fontSizeIntent: "source-match",
    sourceFontFacePx: 16,
    sourceFontSizeConfidence: 0.95,
    sourceFontSizeMethod: "raster-core-v1",
    bubbleLayout: {
      version: 1,
      origin: "detected",
      modelId: "koharu-layout",
      sourceImageRevision: "original",
      confidence: 1,
      direction: "horizontal",
      insetRatio: 0,
      regions: [
        {
          spans: [{ blockStart: 0, blockEnd: 1, inlineStart: 0, inlineEnd: 1 }],
        },
      ],
    },
  });
  const before = structuredClone(f.page);
  const unsafeCandidate = { ...f.block, bbox: f.request.sourceRect };
  expect(f.layout(unsafeCandidate).fontSizePx).not.toBe(
    f.layout(f.block).fontSizePx,
  );
  expect(() => applyMcpSourceRect(f.page, f.request)).toThrow(
    /automatic typography/,
  );
  expect(f.page).toEqual(before);
});
