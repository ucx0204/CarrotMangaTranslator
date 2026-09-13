/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  serializeBlockClipboard,
  parseBlockClipboard,
  instantiateClipboardBlocks,
} from "../src/shared/blockClipboard";
import { resolveBlockTextLayout } from "../src/renderer/src/lib/overlayLayout";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import {
  clearSourceFontFaceRatioCache,
  resolvePageSourceFontFaceFallbacks,
} from "../src/renderer/src/lib/sourceFontSizeMatching";
import type { TranslationBlock } from "../src/shared/textTypes";
import { clipboardBlock } from "./fixtures/blockClipboard";

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

const sourceSize = { width: 1200, height: 1800 };
const targetSize = { width: 2400, height: 1200 };

function textBlock(): TranslationBlock {
  return {
    ...clipboardBlock("text"),
    generatedLettering: undefined,
    sourceText: "元の文章です",
    translatedText: "원래 글자 크기와 줄 배치를 유지합니다",
    renderBbox: { x: 100, y: 200, w: 240, h: 160 },
    renderBboxSpace: "normalized_1000",
    fontSizeIntent: "source-match",
    sourceFontFacePx: 16,
    sourceFontSizeConfidence: 0.95,
    sourceFontSizeMethod: "raster-core-v1",
    autoFitText: true,
    fontFamily: "noto-sans-kr",
    letterSpacing: 0.1,
    fontWidthScale: 0.9,
    outlineWidthPx: 2,
    outlineColor: "#ffffff",
    textOpacity: 0.8,
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
  };
}

describe("clipboard production text layout parity", () => {
  it.each([sourceSize, targetSize])(
    "preserves source-matched size, balanced lines and every visual setting on $width x $height pages",
    (size) => {
      const source = textBlock();
      const payload = parseBlockClipboard(
        serializeBlockClipboard([source], sourceSize),
      );
      const [pasted] = instantiateClipboardBlocks(
        payload,
        size,
        { x: 500, y: 500 },
        () => "new",
      );
      if (!pasted) throw new Error("missing block");
      const before = resolveBlockTextLayout(
        source,
        source.translatedText,
        sourceSize,
        sourceSize,
        DEFAULT_BLOCK_FONT_CATALOG,
      );
      const after = resolveBlockTextLayout(
        pasted,
        pasted.translatedText,
        size,
        size,
        DEFAULT_BLOCK_FONT_CATALOG,
      );
      expect(after.fontSizePx).toBe(before.fontSizePx);
      expect(after.lines).toEqual(before.lines);
      expect(after.layoutWidth).toBeCloseTo(before.layoutWidth);
      expect(after.layoutHeight).toBeCloseTo(before.layoutHeight);
      const {
        id: _id,
        bbox: _bbox,
        renderBbox: _renderBbox,
        ...style
      } = source;
      expect(pasted).toMatchObject(style);
      expect(source.sourceFontFacePx).toBe(16);
    },
  );

  it("captures a peer-derived source size so the destination page cannot replace it", () => {
    const source = {
      ...textBlock(),
      sourceFontFacePx: undefined,
      sourceFontSizeConfidence: undefined,
      sourceFontSizeMethod: undefined,
    };
    const peer = textBlock();
    peer.id = "peer";
    const fallback = resolvePageSourceFontFaceFallbacks(
      [source, peer],
      sourceSize,
    );
    const [pasted] = instantiateClipboardBlocks(
      parseBlockClipboard(
        serializeBlockClipboard([source], sourceSize, fallback),
      ),
      targetSize,
      { x: 500, y: 500 },
      () => "new",
    );
    if (!pasted) throw new Error("missing block");
    const before = resolveBlockTextLayout(
      source,
      source.translatedText,
      sourceSize,
      sourceSize,
      DEFAULT_BLOCK_FONT_CATALOG,
      { sourceFontFaceFallbackPx: fallback.get(source.id) },
    );
    const after = resolveBlockTextLayout(
      pasted,
      pasted.translatedText,
      targetSize,
      targetSize,
      DEFAULT_BLOCK_FONT_CATALOG,
    );
    expect(pasted.sourceFontFacePx).toBeUndefined();
    expect(pasted.sourceFontFaceFallbackPx).toBe(16);
    expect(after.fontSizePx).toBe(before.fontSizePx);
    expect(after.lines).toEqual(before.lines);
    const [secondCopy] = instantiateClipboardBlocks(
      parseBlockClipboard(serializeBlockClipboard([pasted], targetSize)),
      sourceSize,
      { x: 500, y: 500 },
      () => "second-copy",
    );
    expect(secondCopy?.sourceFontFaceFallbackPx).toBe(16);
  });

  it("does not borrow destination typography or change existing blocks' peer estimates", () => {
    const source = {
      ...textBlock(),
      sourceFontFacePx: undefined,
      sourceFontSizeConfidence: undefined,
      sourceFontSizeMethod: undefined,
    };
    const [pasted] = instantiateClipboardBlocks(
      parseBlockClipboard(serializeBlockClipboard([source], sourceSize)),
      targetSize,
      { x: 500, y: 500 },
      () => "new",
    );
    if (!pasted) throw new Error("missing block");
    const peer = {
      ...textBlock(),
      id: "destination-peer",
      sourceFontFacePx: 5,
    };
    const before = resolveBlockTextLayout(
      source,
      source.translatedText,
      sourceSize,
      sourceSize,
      DEFAULT_BLOCK_FONT_CATALOG,
    );
    const fallbacks = resolvePageSourceFontFaceFallbacks(
      [pasted, peer],
      targetSize,
    );
    expect(fallbacks.has(pasted.id)).toBe(false);
    const after = resolveBlockTextLayout(
      pasted,
      pasted.translatedText,
      targetSize,
      targetSize,
      DEFAULT_BLOCK_FONT_CATALOG,
      { sourceFontFaceFallbackPx: 5 },
    );
    expect(after.fontSizePx).toBe(before.fontSizePx);
    expect(after.lines).toEqual(before.lines);
    expect(
      resolvePageSourceFontFaceFallbacks(
        [
          source,
          { ...textBlock(), id: "foreign", sourceFontFaceFallbackPx: null },
          peer,
        ],
        sourceSize,
      ).get(source.id),
    ).toBe(5);
  });

  it("preserves automatically expanded text geometry instead of shrinking it to the OCR box", () => {
    const source = {
      ...clipboardBlock("tiny"),
      generatedLettering: undefined,
      bbox: { x: 200, y: 300, w: 10, h: 10 },
      translatedText: "긴 문장의 원래 크기를 유지합니다",
      autoFitText: true,
    };
    const [pasted] = instantiateClipboardBlocks(
      parseBlockClipboard(serializeBlockClipboard([source], sourceSize)),
      targetSize,
      { x: 500, y: 500 },
      () => "new",
    );
    if (!pasted) throw new Error("missing block");
    const before = resolveBlockTextLayout(
      source,
      source.translatedText,
      sourceSize,
      sourceSize,
      DEFAULT_BLOCK_FONT_CATALOG,
    );
    const after = resolveBlockTextLayout(
      pasted,
      pasted.translatedText,
      targetSize,
      targetSize,
      DEFAULT_BLOCK_FONT_CATALOG,
    );
    expect(after.layoutWidth).toBeCloseTo(before.layoutWidth);
    expect(after.layoutHeight).toBeCloseTo(before.layoutHeight);
    expect(after.fontSizePx).toBe(before.fontSizePx);
    expect(after.lines).toEqual(before.lines);
  });
});
