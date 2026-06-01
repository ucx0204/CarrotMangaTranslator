import { describe, expect, it } from "vitest";
import { filterRejectedOrUncertainSoundItems, overlayItemToBlock } from "../src/main/pipeline/overlayItems";
import type { MangaPage } from "../src/shared/types";
import type { OverlayItem } from "../src/main/pipeline/types";

describe("overlay item conversion", () => {
  it("renders ordinary speech/caption horizontally even when Japanese OCR direction is vertical", () => {
    const page = makePage();
    const block = overlayItemToBlock(
      {
        id: 1,
        type: "nonsolid",
        textRole: "ordinary",
        bbox: { x: 400, y: 100, w: 70, h: 360 },
        jp: "ありがとうございます",
        ko: "감사합니다.",
        direction: "vertical",
        angle: 0,
        fontSize: 28,
        confidence: 1
      },
      page,
      0
    );

    expect(block.sourceDirection).toBe("vertical");
    expect(block.renderDirection).toBe("horizontal");
  });

  it("drops sound-effect items unless confidence is exactly 1", () => {
    const items: OverlayItem[] = [
      {
        id: 1,
        type: "nonsolid",
        textRole: "sound",
        bbox: { x: 10, y: 10, w: 80, h: 80 },
        jp: "ザッ",
        ko: "삭",
        confidence: 0.999
      },
      {
        id: 2,
        type: "nonsolid",
        textRole: "sound",
        bbox: { x: 110, y: 10, w: 80, h: 80 },
        jp: "ドン",
        ko: "쿵",
        confidence: 1
      },
      {
        id: 3,
        type: "nonsolid",
        textRole: "ordinary",
        bbox: { x: 210, y: 10, w: 80, h: 80 },
        jp: "はい",
        ko: "네",
        confidence: 0.8
      }
    ];

    const result = filterRejectedOrUncertainSoundItems(items);

    expect(result.droppedCount).toBe(1);
    expect(result.items.map((item) => item.id)).toEqual([2, 3]);
  });
});

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "001.jpg",
    imagePath: "001.jpg",
    dataUrl: "",
    width: 1000,
    height: 1500,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
