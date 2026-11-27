import type { ComicPageDetection } from "../src/main/bubbleLayout/contracts";
import type { MangaPage } from "../src/shared/libraryTypes";

export function makeFilledDetection(
  label: ComicPageDetection["label"],
  labelId: ComicPageDetection["labelId"],
  box: ComicPageDetection["box"],
): ComicPageDetection {
  return {
    box,
    label,
    labelId,
    mask: {
      logits: new Float32Array(8 * 8).fill(10),
      width: 8,
      height: 8,
    },
    score: 0.99,
  };
}

export function makePage(): MangaPage {
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
        bbox: { x: 375, y: 375, w: 250, h: 250 },
        bboxSpace: "normalized_1000",
        sourceText: "テキスト",
        translatedText: "텍스트",
        confidence: 1,
        sourceDirection: "horizontal",
        renderDirection: "horizontal",
        fontSizePx: 20,
        lineHeight: 1.2,
        textAlign: "center",
        textColor: "#111111",
        backgroundColor: "#ffffff",
        opacity: 0,
      },
    ],
    analysisStatus: "idle",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
}
