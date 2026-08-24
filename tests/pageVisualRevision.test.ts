import { describe, expect, it } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import {
  createPageRevision,
  createPageVisualRevision,
} from "../src/shared/pageRevision";

describe("page visual revision", () => {
  it("ignores OCR and review metadata while the recovery revision changes", () => {
    const page = makePage();
    const metadataOnly = clonePage(page);
    const block = metadataOnly.blocks[0];
    if (!block) throw new Error("missing test block");
    block.sourceText = "更新された原文";
    block.confidence = 0.2;
    block.reviewStatus = "reviewed";
    block.reviewNote = "checked";
    block.speakerId = "speaker-2";

    expect(createPageVisualRevision(metadataOnly)).toBe(
      createPageVisualRevision(page),
    );
    expect(createPageRevision(metadataOnly)).not.toBe(createPageRevision(page));
  });

  it("changes for every page-pixel input but not for the mask mirror alone", () => {
    const page = makePage();
    const translated = clonePage(page);
    requireBlock(translated).translatedText = "바뀐 번역";
    const positioned = clonePage(page);
    requireBlock(positioned).renderBbox = { x: 50, y: 50, w: 300, h: 200 };
    const inpainted = clonePage(page);
    inpainted.inpaintedImagePath = "C:/pages/inpainted.png";
    const maskOnly = clonePage(page);
    maskOnly.inpaintMaskPath = "C:/pages/mask.png";
    maskOnly.maskProvenance = "actual-mask";

    for (const changed of [translated, positioned, inpainted]) {
      expect(createPageVisualRevision(changed)).not.toBe(
        createPageVisualRevision(page),
      );
    }
    expect(createPageVisualRevision(maskOnly)).toBe(
      createPageVisualRevision(page),
    );
  });
});

function makePage(): MangaPage {
  const timestamp = "2026-08-24T00:00:00.000Z";
  const block = {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 300, h: 200 },
    sourceText: "原文",
    translatedText: "번역",
    confidence: 0.9,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    outlineColor: "#ffffff",
    outlineWidthScale: 1,
    backgroundColor: "#ffffff",
    opacity: 1,
  } as TranslationBlock;
  return {
    id: "page-1",
    name: "001.png",
    imagePath: "C:/pages/001.png",
    dataUrl: "",
    width: 1000,
    height: 1500,
    blocks: [block],
    blockOrder: [block.id],
    analysisStatus: "completed",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function clonePage(page: MangaPage): MangaPage {
  return structuredClone(page);
}

function requireBlock(page: MangaPage): TranslationBlock {
  const block = page.blocks[0];
  if (!block) throw new Error("missing test block");
  return block;
}
