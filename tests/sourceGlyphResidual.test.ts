import { describe, expect, it } from "vitest";
import type { InpaintingWindowMask } from "../src/main/inpainting/inpaintingEngine";
import {
  buildSourceGlyphEvidence,
  measureSourceGlyphResidual,
} from "../src/main/inpainting/sourceGlyphResidual";
import type { MangaPage } from "../src/shared/libraryTypes";

describe("source glyph residual validation", () => {
  it("vetoes a one-pixel engine change when the source glyph remains", () => {
    const before = solidBitmap(16, 16, 255);
    const after = Buffer.from(before);
    setGray(after, 16, 7, 7, 0);
    const sourceEvidence = {
      strategy: "adaptive" as const,
      windowMask: filledMask({ x: 4, y: 4, w: 6, h: 6 }),
    };

    const diagnostic = measureSourceGlyphResidual({
      after,
      before,
      blockId: "block-1",
      firstPassCore: sourceEvidence.windowMask,
      pageWidth: 16,
      sourceEvidence,
    });

    expect(diagnostic).toEqual(
      expect.objectContaining({
        sourceSeedCount: 36,
        sourceLikeRemainingCount: 35,
        sourceLikeRemainingRatio: 35 / 36,
        largestResidualComponent: 35,
        residualVeto: true,
      }),
    );
  });

  it.each([
    { name: "black-on-white", background: 248, stroke: 8, edge: 8 },
    { name: "white-on-black", background: 8, stroke: 248, edge: 248 },
    { name: "antialiased", background: 248, stroke: 16, edge: 128 },
  ])("detects and vetoes intact $name source glyphs", (fixture) => {
    const page = makePage();
    const block = requireFirstBlock(page);
    const before = solidBitmap(page.width, page.height, fixture.background);
    drawGlyph(before, page.width, fixture.stroke, fixture.edge);
    const sourceEvidence = buildSourceGlyphEvidence({
      bitmap: before,
      block,
      height: page.height,
      page,
      width: page.width,
    });
    const after = Buffer.from(before);
    setGray(after, page.width, 10, 10, 255 - fixture.background);

    const diagnostic = measureSourceGlyphResidual({
      after,
      before,
      blockId: "block-1",
      firstPassCore: sourceEvidence.windowMask,
      pageWidth: page.width,
      sourceEvidence,
    });

    expect(sourceEvidence.strategy).not.toBe("none");
    expect(diagnostic.sourceSeedCount).toBeGreaterThanOrEqual(24);
    expect(diagnostic.residualVeto).toBe(true);
  });

  it("does not treat retained halftone dots as a residual glyph", () => {
    const page = makePage();
    const block = requireFirstBlock(page);
    const before = solidBitmap(page.width, page.height, 238);
    for (let y = 9; y < 56; y += 5) {
      for (let x = 9; x < 56; x += 5) {
        setGray(before, page.width, x, y, 175);
      }
    }
    drawGlyph(before, page.width, 12, 92);
    const sourceEvidence = buildSourceGlyphEvidence({
      bitmap: before,
      block,
      height: page.height,
      page,
      width: page.width,
    });
    const after = Buffer.from(before);
    eraseGlyph(after, page.width, 238);

    const diagnostic = measureSourceGlyphResidual({
      after,
      before,
      blockId: "block-1",
      firstPassCore: sourceEvidence.windowMask,
      pageWidth: page.width,
      sourceEvidence,
    });

    expect(sourceEvidence.strategy).not.toBe("none");
    expect(diagnostic.sourceSeedCount).toBeGreaterThanOrEqual(24);
    expect(diagnostic.residualVeto).toBe(false);
  });

  it("records evidence outside the first-pass core without vetoing tiny line art", () => {
    const before = solidBitmap(16, 16, 255);
    const after = Buffer.from(before);
    setGray(after, 16, 0, 0, 0);
    const evidenceMask = emptyMask({ x: 3, y: 3, w: 10, h: 4 });
    for (let x = 0; x < 10; x += 1) evidenceMask.data[x] = 1;
    const firstPassCore = emptyMask({ x: 3, y: 3, w: 5, h: 4 });
    firstPassCore.data.fill(1);

    const diagnostic = measureSourceGlyphResidual({
      after,
      before,
      blockId: "line-art",
      firstPassCore,
      pageWidth: 16,
      sourceEvidence: { strategy: "adaptive", windowMask: evidenceMask },
    });

    expect(diagnostic.sourceSeedCount).toBe(10);
    expect(diagnostic.sourceSeedOutsideFirstPassCore).toBe(5);
    expect(diagnostic.sourceSeedOutsideFirstPassCoreRatio).toBe(0.5);
    expect(diagnostic.largestResidualComponent).toBe(10);
    expect(diagnostic.residualVeto).toBe(false);
  });
});

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "page.png",
    imagePath: "page.png",
    dataUrl: "",
    width: 64,
    height: 64,
    blocks: [
      {
        id: "block-1",
        type: "nonsolid",
        bbox: { x: 250, y: 250, w: 500, h: 500 },
        sourceText: "source",
        translatedText: "translated",
        confidence: 1,
        sourceDirection: "horizontal",
        renderDirection: "horizontal",
        fontSizePx: 16,
        lineHeight: 1.2,
        textAlign: "center",
        textColor: "#000000",
        backgroundColor: "#ffffff",
        opacity: 1,
      },
    ],
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function requireFirstBlock(page: MangaPage): MangaPage["blocks"][number] {
  const block = page.blocks[0];
  if (!block) throw new Error("expected source block");
  return block;
}

function drawGlyph(
  bitmap: Buffer,
  width: number,
  stroke: number,
  edge: number,
): void {
  fillGray(bitmap, width, { x: 26, y: 18, w: 10, h: 30 }, edge);
  fillGray(bitmap, width, { x: 28, y: 20, w: 6, h: 26 }, stroke);
  fillGray(bitmap, width, { x: 18, y: 29, w: 28, h: 10 }, edge);
  fillGray(bitmap, width, { x: 20, y: 31, w: 24, h: 6 }, stroke);
}

function eraseGlyph(bitmap: Buffer, width: number, value: number): void {
  fillGray(bitmap, width, { x: 18, y: 18, w: 28, h: 30 }, value);
}

function solidBitmap(width: number, height: number, value: number): Buffer {
  return Buffer.alloc(width * height * 4, value);
}

function filledMask(
  bounds: InpaintingWindowMask["bounds"],
): InpaintingWindowMask {
  return { bounds, data: new Uint8Array(bounds.w * bounds.h).fill(1) };
}

function emptyMask(
  bounds: InpaintingWindowMask["bounds"],
): InpaintingWindowMask {
  return { bounds, data: new Uint8Array(bounds.w * bounds.h) };
}

function fillGray(
  bitmap: Buffer,
  width: number,
  rect: { x: number; y: number; w: number; h: number },
  value: number,
): void {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      setGray(bitmap, width, x, y, value);
    }
  }
}

function setGray(
  bitmap: Buffer,
  width: number,
  x: number,
  y: number,
  value: number,
): void {
  const offset = (y * width + x) * 4;
  bitmap[offset] = value;
  bitmap[offset + 1] = value;
  bitmap[offset + 2] = value;
  bitmap[offset + 3] = 255;
}
