import { describe, expect, it } from "vitest";
import {
  serializeBlockClipboard,
  parseBlockClipboard,
  instantiateClipboardBlocks,
} from "../src/shared/blockClipboard";
import { TranslationBlockSchema } from "../src/shared/ipcSchemaPrimitives";
import { clipboardBlock } from "./fixtures/blockClipboard";

const SOURCE_SIZE = { width: 1200, height: 1800 };
const TARGET_SIZE = { width: 2400, height: 1200 };

describe("portable block clipboard", () => {
  it("rejects corrupt, foreign, empty and invalid image payloads", () => {
    const serialized = serializeBlockClipboard([clipboardBlock()], SOURCE_SIZE);
    expect(() => parseBlockClipboard("{invalid")).toThrow();
    expect(() =>
      parseBlockClipboard(serialized.replace('"version":1', '"version":2')),
    ).toThrow();
    expect(() => serializeBlockClipboard([], SOURCE_SIZE)).toThrow();
    const malformed = JSON.parse(serialized);
    malformed.blocks[0].generatedLettering.dataUrl = "file:///private.png";
    expect(() => parseBlockClipboard(JSON.stringify(malformed))).toThrow();
  });

  it("keeps image bytes, pixel size, formatting and relative placement across page sizes", () => {
    const image = clipboardBlock();
    const text = {
      ...clipboardBlock("text"),
      generatedLettering: undefined,
      bbox: { x: 440, y: 400, w: 120, h: 100 },
      translatedText: "<b>본문</b>",
    };
    const payload = parseBlockClipboard(
      serializeBlockClipboard([image, text], SOURCE_SIZE),
    );
    let id = 0;
    const pasted = instantiateClipboardBlocks(
      payload,
      TARGET_SIZE,
      { x: 500, y: 500 },
      () => `copy-${++id}`,
    );
    expect(pasted.map((block) => block.id)).toEqual(["copy-1", "copy-2"]);
    expect(pasted[0]?.generatedLettering?.dataUrl).toBe(
      image.generatedLettering?.dataUrl,
    );
    expect(pasted[0]?.renderBbox).toMatchObject({ w: 120, h: 240 });
    expect(pasted[1]?.renderBbox).toMatchObject({ w: 60, h: 150 });
    expect(
      (pasted[1]?.renderBbox?.x ?? 0) - (pasted[0]?.renderBbox?.x ?? 0),
    ).toBeCloseTo(170);
    expect(pasted[1]?.translatedText).toBe(text.translatedText);
    expect(pasted[1]?.fontWeight).toBe(700);
    for (const block of pasted)
      expect(TranslationBlockSchema.safeParse(block).success).toBe(true);
  });

  it("relocates page masks and occlusion while keeping asset masks independent", () => {
    const source = clipboardBlock();
    const payload = parseBlockClipboard(
      serializeBlockClipboard([source], SOURCE_SIZE),
    );
    const [pasted] = instantiateClipboardBlocks(
      payload,
      TARGET_SIZE,
      { x: 500, y: 500 },
      () => "new",
    );
    const artwork = pasted?.generatedLettering;
    if (!artwork) throw new Error("missing pasted artwork");
    expect(artwork.maskStrokes?.[1]).toMatchObject({
      points: [{ x: 500, y: 500 }],
      radiusX: 5,
      radiusY: 22.5,
    });
    expect(artwork.occlusionPolygons?.[0]?.[0]).toEqual({
      x: 440,
      y: 380,
    });
    expect(artwork.maskStrokes?.[0]).toEqual(
      source.generatedLettering?.maskStrokes?.[0],
    );
    artwork.maskStrokes?.[0]?.points.push({
      x: 999,
      y: 999,
    });
    expect(source.generatedLettering?.maskStrokes?.[0]?.points).toHaveLength(1);
    expect(
      payload.blocks[0]?.generatedLettering?.maskStrokes?.[0]?.points,
    ).toHaveLength(1);
  });

  it("normalizes pixel geometry and removes source-only associations from pasted blocks", () => {
    const source = {
      ...clipboardBlock(),
      bboxSpace: "pixels" as const,
      bbox: { x: 120, y: 360, w: 288, h: 288 },
      speakerId: "old-speaker",
      glossaryEntryIds: ["old-term"],
      visualClusterId: "old-cluster",
      reviewStatus: "reviewed" as const,
      bubbleLayout: {
        version: 1 as const,
        direction: "horizontal" as const,
        confidence: 1,
        origin: "detected" as const,
        modelId: "model",
        sourceImageRevision: "old-revision",
        insetRatio: 0,
        regions: [
          {
            spans: [
              { blockStart: 0, blockEnd: 1, inlineStart: 0, inlineEnd: 1 },
            ],
          },
        ],
      },
    };
    const payload = parseBlockClipboard(
      serializeBlockClipboard([source], SOURCE_SIZE),
    );
    expect(payload.blocks[0]?.bbox).toEqual({ x: 100, y: 200, w: 240, h: 160 });
    const [pasted] = instantiateClipboardBlocks(
      payload,
      TARGET_SIZE,
      { x: 500, y: 500 },
      () => "new",
    );
    for (const key of [
      "speakerId",
      "glossaryEntryIds",
      "visualClusterId",
      "reviewStatus",
    ])
      expect(pasted).not.toHaveProperty(key);
    expect(pasted?.inpaintExcluded).toBe(true);
    expect(pasted?.bubbleLayout?.regions).toEqual(source.bubbleLayout.regions);
    expect(pasted?.bubbleLayout?.origin).toBe("manual");
    expect(pasted?.bubbleLayout).not.toHaveProperty("sourceImageRevision");
    expect(source.bubbleLayout.sourceImageRevision).toBe("old-revision");
  });
});
