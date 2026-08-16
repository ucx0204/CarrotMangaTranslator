import { readPsd, type LayerTextData } from "ag-psd";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import {
  buildPagePsd,
  cropTransparentPixelData,
  resolveEditablePsdText,
} from "../src/main/jobs/pagePsdExport";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import { createIdentityWarpTransform } from "../src/shared/blockTransforms";

describe("layered PSD export", () => {
  it("writes a flat bottom-to-top stack with text above both backgrounds", () => {
    const page = makePage();
    const background = makePng(4, 3, [255, 255, 255, 255]);
    const cleaned = makePng(4, 3, [240, 240, 240, 255]);
    const text = makePng(4, 3, [0, 0, 0, 0], [2, 1, 10, 20, 30, 255]);
    const secondText = makePng(4, 3, [0, 0, 0, 0], [3, 2, 30, 20, 10, 255]);
    const firstBlock = page.blocks[0] as TranslationBlock;
    const secondBlock = {
      ...firstBlock,
      id: "block-2",
      translatedText: "second",
    };

    const output = buildPagePsd({
      page,
      compositePng: cleaned,
      originalBackgroundPng: background,
      cleanedBackgroundPng: cleaned,
      textLayers: [
        { block: firstBlock, png: text },
        { block: secondBlock, png: secondText },
      ],
    });
    expect(output.subarray(0, 4).toString()).toBe("8BPS");

    const psd = readPsd(output, {
      skipCompositeImageData: true,
      skipLayerImageData: true,
      skipThumbnail: true,
    });
    expect(psd.children?.map((layer) => layer.name)).toEqual([
      "원본 배경 (Original)",
      "정리 배경 (Inpaint)",
      "001 translated",
      "002 second",
    ]);
    expect(psd.children?.every((layer) => layer.children === undefined)).toBe(
      true,
    );
    const editableText = psd.children?.[2]?.text;
    expectRoundTrippedEditableText(editableText);
    expect(psd.children?.[0]?.protected).toMatchObject({
      composite: true,
      position: true,
      transparency: true,
    });
  });

  it("writes finite document-space bounds for editable text instead of a canvas-sized box", () => {
    const text = resolveEditablePsdText(makeBlock(), {
      width: 1000,
      height: 1600,
    });

    expect(text).toMatchObject({
      left: 100,
      top: 160,
      right: 600,
      bottom: 640,
      boxBounds: [0, 0, 500, 480],
      bounds: {
        left: { units: "Pixels", value: 100 },
        top: { units: "Pixels", value: 160 },
        right: { units: "Pixels", value: 600 },
        bottom: { units: "Pixels", value: 640 },
      },
      boundingBox: {
        left: { units: "Pixels", value: 100 },
        top: { units: "Pixels", value: 160 },
        right: { units: "Pixels", value: 600 },
        bottom: { units: "Pixels", value: 640 },
      },
    });
    expect(text?.transform?.every(Number.isFinite)).toBe(true);
    expect(
      [text?.left, text?.top, text?.right, text?.bottom].every(Number.isFinite),
    ).toBe(true);
  });

  it("keeps legacy PSD outline sizing and uses pixels only after manual conversion", () => {
    const legacy = resolveEditablePsdText(
      { ...makeBlock(), outlineWidthScale: 1.7 },
      { width: 1000, height: 1600 },
    );
    const pixels = resolveEditablePsdText(
      { ...makeBlock(), outlineWidthPx: 8.5, outlineWidthScale: 1.7 },
      { width: 1000, height: 1600 },
    );

    expect(legacy?.style?.outlineWidth).toBe(1.7);
    expect(pixels?.style?.outlineWidth).toBe(8.5);
  });

  it("crops transparent layer pixels and keeps complex text raster-only", () => {
    const data = new Uint8Array(4 * 3 * 4);
    data.set([1, 2, 3, 255], (1 * 4 + 2) * 4);
    expect(
      cropTransparentPixelData({ data, width: 4, height: 3 }),
    ).toMatchObject({
      left: 2,
      top: 1,
      imageData: { width: 1, height: 1 },
    });
    expect(
      resolveEditablePsdText(
        { ...makeBlock(), renderDirection: "vertical" },
        { width: 1000, height: 1600 },
      ),
    ).toBeNull();
    expect(
      resolveEditablePsdText(
        { ...makeBlock(), warpTransform: createIdentityWarpTransform(3) },
        { width: 1000, height: 1600 },
      ),
    ).toBeNull();
    expect(
      resolveEditablePsdText(
        {
          ...makeBlock(),
          translatedText: "[size=48]큰 글자[/size]와 보통 글자",
        },
        { width: 1000, height: 1600 },
      ),
    ).toBeNull();
  });

  it("rejects a broken full-canvas opaque text capture", () => {
    const page = makePage();
    const background = makePng(4, 3, [255, 255, 255, 255]);
    const opaqueTextCapture = makePng(4, 3, [16, 17, 20, 255]);

    expect(() =>
      buildPagePsd({
        page,
        compositePng: background,
        originalBackgroundPng: background,
        textLayers: [
          { block: page.blocks[0] as TranslationBlock, png: opaqueTextCapture },
        ],
      }),
    ).toThrow(/fully opaque.*block-1.*page\.png/i);
  });
});

function expectRoundTrippedEditableText(
  editableText: LayerTextData | undefined,
): void {
  expect(editableText).toBeDefined();
  if (!editableText) throw new Error("Expected an editable PSD text layer.");
  expect(editableText.text).toBe("translated");
  expect(
    [
      editableText.left,
      editableText.top,
      editableText.right,
      editableText.bottom,
    ].every((value) => typeof value === "number" && Number.isFinite(value)),
  ).toBe(true);
  expect(editableText.left).toBeCloseTo(0.4);
  expect(editableText.top).toBeCloseTo(0.3);
  expect(editableText.right).toBeCloseTo(2.4);
  expect(editableText.bottom).toBeCloseTo(1.3);
  expect(editableText.boxBounds).toEqual([0, 0, 2, 1]);
  expect(editableText.bounds?.left.value).toBeCloseTo(0.4);
  expect(editableText.bounds?.top.value).toBeCloseTo(0.3);
  expect(editableText.bounds?.right.value).toBeCloseTo(2.4);
  expect(editableText.bounds?.bottom.value).toBeCloseTo(1.3);
}

function makePng(
  width: number,
  height: number,
  fill: [number, number, number, number],
  pixel?: [number, number, number, number, number, number],
): Buffer {
  const image = new PNG({ width, height });
  for (let index = 0; index < width * height; index += 1) {
    image.data.set(fill, index * 4);
  }
  if (pixel) {
    const [x, y, r, g, b, a] = pixel;
    image.data.set([r, g, b, a], (y * width + x) * 4);
  }
  return PNG.sync.write(image);
}

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "page.png",
    imagePath: "page.png",
    inpaintedImagePath: "page-clean.png",
    dataUrl: "",
    width: 4,
    height: 3,
    blocks: [makeBlock()],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeBlock(): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 500, h: 300 },
    sourceText: "source",
    translatedText: "translated",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#112233",
    outlineColor: "#ffffff",
    outlineWidthScale: 1,
    backgroundColor: "#ffffff",
    opacity: 0.2,
  };
}
