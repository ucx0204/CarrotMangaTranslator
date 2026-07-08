import { describe, expect, it } from "vitest";
import type { MangaPage } from "../src/shared/types";
import type { OverlayItem } from "../src/main/pipeline/types";
import { validateOverlayItemsAgainstReferences } from "../src/main/pipeline/overlayItemReferences";

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "001.png",
    imagePath: "C:/page-1.png",
    dataUrl: "data:image/png;base64,aaa",
    width: 1200,
    height: 1800,
    blocks: [],
    analysisStatus: "completed",
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}

function makeMergedUiListItem(): OverlayItem {
  return {
    id: 1,
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 600, h: 700 },
    jp: "1 メニュー: 2 セーブ: 3 ロード: 4 クエスト",
    ko: "1 메뉴: 2 저장: 3 불러오기: 4 퀘스트",
    direction: "vertical",
  };
}

describe("validateOverlayItemsAgainstReferences", () => {
  it("drops a merged UI list block in whole-page mode", () => {
    const result = validateOverlayItemsAgainstReferences(
      [makeMergedUiListItem()],
      makePage(),
      [],
    );

    expect(result.items).toHaveLength(0);
    expect(result.reasons.merged_ui_list).toBe(1);
  });

  it("keeps the user-selected result in region crop mode even if it looks like a merged UI list", () => {
    const result = validateOverlayItemsAgainstReferences(
      [makeMergedUiListItem()],
      makePage(),
      [],
      [],
      { regionCropMode: true },
    );

    expect(result.items).toHaveLength(1);
    expect(result.droppedCount).toBe(0);
  });

  it("keeps short non-Japanese text in region crop mode that page mode treats as fragment noise", () => {
    const item: OverlayItem = {
      id: 1,
      type: "nonsolid",
      bbox: { x: 100, y: 100, w: 200, h: 100 },
      jp: "OK",
      ko: "오케이",
    };

    const pageMode = validateOverlayItemsAgainstReferences(
      [item],
      makePage(),
      [],
    );
    const regionMode = validateOverlayItemsAgainstReferences(
      [item],
      makePage(),
      [],
      [],
      { regionCropMode: true },
    );

    expect(pageMode.reasons.fragment_noise).toBe(1);
    expect(regionMode.items).toHaveLength(1);
  });

  it("still drops an empty-source item in region crop mode", () => {
    const item: OverlayItem = {
      id: 1,
      type: "nonsolid",
      bbox: { x: 100, y: 100, w: 200, h: 100 },
      jp: "  ",
      ko: "번역",
    };

    const result = validateOverlayItemsAgainstReferences(
      [item],
      makePage(),
      [],
      [],
      { regionCropMode: true },
    );

    expect(result.items).toHaveLength(0);
    expect(result.reasons.empty_source).toBe(1);
  });
});
