import { describe, expect, it } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
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

  it("keeps large short non-Japanese text in page mode but drops ruby-sized fragments", () => {
    const largeItem: OverlayItem = {
      id: 1,
      type: "nonsolid",
      bbox: { x: 100, y: 100, w: 200, h: 100 },
      jp: "OK",
      ko: "오케이",
    };
    const smallItem: OverlayItem = {
      id: 2,
      type: "nonsolid",
      bbox: { x: 100, y: 100, w: 30, h: 20 },
      jp: "OK",
      ko: "오케이",
    };

    const largePage = validateOverlayItemsAgainstReferences(
      [largeItem],
      makePage(),
      [],
      [],
      { sourceLanguage: "ja" },
    );
    const smallPage = validateOverlayItemsAgainstReferences(
      [smallItem],
      makePage(),
      [],
      [],
      { sourceLanguage: "ja" },
    );
    const regionMode = validateOverlayItemsAgainstReferences(
      [largeItem],
      makePage(),
      [],
      [],
      { regionCropMode: true },
    );

    // 큰 블록(20,000)의 짧은 비일본어 텍스트는 노이즈가 아니다(살린다).
    expect(largePage.items).toHaveLength(1);
    expect(largePage.reasons.fragment_noise).toBeUndefined();
    // 루비급(600)은 여전히 fragment_noise로 제거된다.
    expect(smallPage.reasons.fragment_noise).toBe(1);
    expect(regionMode.items).toHaveLength(1);
  });

  it("keeps short text in whole-page mode for non-Japanese source languages", () => {
    const englishItem: OverlayItem = {
      id: 1,
      type: "nonsolid",
      bbox: { x: 100, y: 100, w: 200, h: 100 },
      jp: "Hi",
      ko: "안녕",
    };
    const koreanItem: OverlayItem = {
      id: 2,
      type: "nonsolid",
      bbox: { x: 400, y: 100, w: 200, h: 100 },
      jp: "응",
      ko: "Yes",
    };

    const english = validateOverlayItemsAgainstReferences(
      [englishItem],
      makePage(),
      [],
      [],
      { sourceLanguage: "en" },
    );
    const korean = validateOverlayItemsAgainstReferences(
      [koreanItem],
      makePage(),
      [],
      [],
      { sourceLanguage: "ko" },
    );

    expect(english.items).toHaveLength(1);
    expect(korean.items).toHaveLength(1);
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

  it("remaps a large block whose wrong id overlaps a single OCR candidate", () => {
    const hints = [
      { id: 5, x1: 100, y1: 100, x2: 400, y2: 500, ocrText: "こんにちは" },
    ];
    const largeItem: OverlayItem = {
      id: 99, // 후보 id가 아닌 잘못된 id
      type: "nonsolid",
      textRole: "ordinary",
      bbox: { x: 100, y: 50, w: 300, h: 450 }, // 후보 안을 강하게 포함
      jp: "こんにちは",
      ko: "안녕하세요",
    };

    const result = validateOverlayItemsAgainstReferences(
      [largeItem],
      makePage(),
      hints as never,
      [],
      { sourceLanguage: "ja" },
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe(5); // 후보 id로 재매핑
    expect(result.remappedCount).toBe(1);
    expect(result.reasons.new_id_overlaps_ocr_candidate).toBeUndefined();
  });

  it("drops a small block whose wrong id overlaps an OCR candidate (ruby-like)", () => {
    // 후보 pixel (100,100)-(130,120)는 1200x1800 페이지에서 normalized_1000
    // 박스 ~(83,55,25,11)로 변환된다. 작은 블록을 그 안에 겹치게 둔다.
    const hints = [
      { id: 5, x1: 100, y1: 100, x2: 130, y2: 120, ocrText: "ルビ" },
    ];
    const smallItem: OverlayItem = {
      id: 99,
      type: "nonsolid",
      textRole: "ordinary",
      bbox: { x: 80, y: 50, w: 30, h: 20 },
      jp: "ルビ",
      ko: "루비",
    };

    const result = validateOverlayItemsAgainstReferences(
      [smallItem],
      makePage(),
      hints as never,
      [],
      { sourceLanguage: "ja" },
    );

    expect(result.items).toHaveLength(0);
    expect(result.reasons.new_id_overlaps_ocr_candidate).toBe(1);
    expect(result.remappedCount).toBe(0);
  });

  it("preserves a large duplicate block but drops a ruby-sized duplicate", () => {
    const first: OverlayItem = {
      id: 1,
      type: "nonsolid",
      textRole: "ordinary",
      bbox: { x: 100, y: 100, w: 300, h: 200 },
      jp: "逃げろ",
      ko: "도망쳐",
    };
    const largeDup: OverlayItem = {
      id: 2,
      type: "nonsolid",
      textRole: "ordinary",
      bbox: { x: 110, y: 110, w: 300, h: 200 }, // 인접 + 동일 텍스트, 큼
      jp: "逃げろ",
      ko: "도망쳐",
    };
    const rubyDup: OverlayItem = {
      id: 3,
      type: "nonsolid",
      textRole: "ordinary",
      bbox: { x: 105, y: 105, w: 30, h: 20 }, // 인접 + 동일 텍스트, 루비급
      jp: "逃げろ",
      ko: "도망쳐",
    };

    const withLarge = validateOverlayItemsAgainstReferences(
      [first, largeDup],
      makePage(),
      [],
      [],
      { sourceLanguage: "ja" },
    );
    const withRuby = validateOverlayItemsAgainstReferences(
      [first, rubyDup],
      makePage(),
      [],
      [],
      { sourceLanguage: "ja" },
    );

    expect(withLarge.items).toHaveLength(2); // 큰 중복은 보존
    expect(withLarge.reasons.duplicate_physical_text).toBeUndefined();
    expect(withRuby.items).toHaveLength(1); // 루비급 중복은 제거
    expect(withRuby.reasons.duplicate_physical_text).toBe(1);
  });

  it("reports omitted text-bearing candidates the model did not cover", () => {
    const hints = [
      { id: 1, x1: 10, y1: 10, x2: 100, y2: 100, ocrText: "台詞一" },
      { id: 2, x1: 110, y1: 10, x2: 200, y2: 100, ocrText: "台詞二" },
      { id: 3, x1: 210, y1: 10, x2: 300, y2: 100 }, // 텍스트 근거 없음
    ];
    const covered: OverlayItem = {
      id: 1,
      type: "nonsolid",
      textRole: "ordinary",
      bbox: { x: 10, y: 10, w: 90, h: 90 },
      jp: "台詞一",
      ko: "대사 일",
    };

    const result = validateOverlayItemsAgainstReferences(
      [covered],
      makePage(),
      hints as never,
      [],
      { sourceLanguage: "ja" },
    );

    // 후보 1은 커버, 후보 2는 텍스트 후보지만 미커버 → 누락, 후보 3은 텍스트 근거 없음 → 제외.
    expect(result.omittedCandidateIds).toEqual([2]);
  });
});
