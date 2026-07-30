import { describe, expect, it } from "vitest";
import {
  filterRejectedOrUncertainSoundItems,
  overlayItemToBlock,
} from "../src/main/pipeline/overlayItems";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { OverlayItem } from "../src/main/pipeline/types";
import { DEFAULT_BLOCK_FORMAT_DEFAULTS } from "../src/shared/blockFormat";

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
        confidence: 1,
      },
      page,
      0,
    );

    expect(block.sourceDirection).toBe("vertical");
    expect(block.renderDirection).toBe("horizontal");
    expect(block.textRole).toBe("ordinary");
  });

  it("keeps translated ordinary text upright when the model reports a left slant", () => {
    const block = overlayItemToBlock(
      {
        id: 1,
        type: "nonsolid",
        textRole: "ordinary",
        bbox: { x: 400, y: 100, w: 70, h: 360 },
        jp: "ありがとうございます",
        ko: "감사합니다.",
        direction: "vertical",
        angle: -30,
        confidence: 1,
      },
      makePage(),
      0,
    );

    expect(block.rotationDeg).toBe(0);
  });

  it("preserves a detected source slant for sound effects", () => {
    const block = overlayItemToBlock(
      {
        id: 1,
        type: "nonsolid",
        textRole: "sound",
        bbox: { x: 100, y: 100, w: 200, h: 120 },
        jp: "ドン",
        ko: "쾅",
        angle: -18,
        confidence: 1,
      },
      makePage(),
      0,
    );

    expect(block.rotationDeg).toBe(-18);
    expect(block.textRole).toBe("sound");
  });

  it("preserves a visible slant for ordinary horizontal text", () => {
    const block = overlayItemToBlock(
      {
        id: 1,
        type: "nonsolid",
        textRole: "ordinary",
        bbox: { x: 100, y: 100, w: 240, h: 100 },
        jp: "ありがとう",
        ko: "고마워",
        direction: "horizontal",
        angle: -18,
        confidence: 1,
      },
      makePage(),
      0,
    );

    expect(block.rotationDeg).toBe(-18);
  });

  it("prefers language-neutral text aliases when creating a block", () => {
    const block = overlayItemToBlock(
      {
        id: 1,
        type: "nonsolid",
        bbox: { x: 10, y: 10, w: 180, h: 80 },
        jp: "legacy source",
        ko: "legacy target",
        sourceText: "Hello",
        translatedText: "Bonjour",
      },
      makePage(),
      0,
    );

    expect(block.sourceText).toBe("Hello");
    expect(block.translatedText).toBe("Bonjour");
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
        confidence: 0.999,
      },
      {
        id: 2,
        type: "nonsolid",
        textRole: "sound",
        bbox: { x: 110, y: 10, w: 80, h: 80 },
        jp: "ドン",
        ko: "쿵",
        confidence: 1,
      },
      {
        id: 3,
        type: "nonsolid",
        textRole: "ordinary",
        bbox: { x: 210, y: 10, w: 80, h: 80 },
        jp: "はい",
        ko: "네",
        confidence: 0.8,
      },
    ];

    const result = filterRejectedOrUncertainSoundItems(items);

    expect(result.droppedCount).toBe(1);
    expect(result.items.map((item) => item.id)).toEqual([2, 3]);
  });

  it("can preserve manually selected sound-effect items below full-page confidence", () => {
    const items: OverlayItem[] = [
      {
        id: 1,
        type: "nonsolid",
        textRole: "sound",
        bbox: { x: 10, y: 10, w: 80, h: 80 },
        jp: "スタコラサッサ",
        ko: "후다닥",
        confidence: 0.95,
      },
    ];

    const result = filterRejectedOrUncertainSoundItems(items, {
      dropUncertainSound: false,
    });

    expect(result.droppedCount).toBe(0);
    expect(result.items.map((item) => item.id)).toEqual([1]);
  });

  it("applies natural hard breaks without changing the wrapping policy", () => {
    const defaults = {
      ...DEFAULT_BLOCK_FORMAT_DEFAULTS,
      renderDirection: "horizontal" as const,
      wordBreak: "keep-all" as const,
    };
    const block = overlayItemToBlock(
      {
        id: 1,
        type: "nonsolid",
        textRole: "ordinary",
        bbox: { x: 100, y: 100, w: 72, h: 180 },
        jp: "超人工知能翻訳技術",
        ko: "초인공지능번역기술",
        direction: "horizontal",
        fontSize: 20,
        confidence: 1,
      },
      makePage(),
      0,
      undefined,
      defaults,
      { enabled: true, locale: "ko" },
    );

    expect(block.translatedText).toBe("초인공지능번역기술");
    expect(block.wordBreak).toBe("keep-all");
    expect(block.renderDirection).toBe("horizontal");
  });

  it("applies natural hard breaks when no wrapping default is materialized", () => {
    const block = overlayItemToBlock(
      {
        id: 1,
        type: "nonsolid",
        textRole: "ordinary",
        bbox: { x: 100, y: 100, w: 100, h: 120 },
        jp: "既存ブロックの折り返し設定はそのままです",
        ko: "기존 블록의 줄바꿈 서식은 그대로 둡니다",
        direction: "horizontal",
        fontSize: 20,
        confidence: 1,
      },
      makePage(),
      0,
      undefined,
      undefined,
      { enabled: true, locale: "ko" },
    );

    expect(block.translatedText).toContain("\n");
    expect(block.wordBreak).toBeUndefined();
    expect(block.renderDirection).toBe("horizontal");
  });

  it("matches a Korean font before applying natural line layout", () => {
    const block = overlayItemToBlock(
      {
        id: 1,
        type: "nonsolid",
        textRole: "ordinary",
        bbox: { x: 100, y: 100, w: 100, h: 120 },
        jp: "既存ブロックの折り返し設定はそのままです",
        ko: "기존 블록의 줄바꿈 서식은 그대로 둡니다",
        direction: "horizontal",
        fontSize: 20,
        confidence: 1,
      },
      makePage(),
      0,
      undefined,
      { ...DEFAULT_BLOCK_FORMAT_DEFAULTS, fontFamily: "jua" },
      { enabled: true, locale: "ko" },
      {
        enabled: true,
        targetLanguage: "ko",
        workTitle: "공작 영애의 계약 결혼",
      },
    );

    expect(block.fontFamily).toBe("ridi-batang");
    expect(block.translatedText).toContain("\n");
  });

  it("uses the English built-in catalog for an English target", () => {
    const block = overlayItemToBlock(
      {
        id: 1,
        type: "nonsolid",
        textRole: "sound",
        bbox: { x: 100, y: 100, w: 200, h: 120 },
        jp: "ドン",
        ko: "Boom",
        confidence: 1,
      },
      makePage(),
      0,
      undefined,
      { ...DEFAULT_BLOCK_FORMAT_DEFAULTS, fontFamily: "comic-neue" },
      undefined,
      {
        enabled: true,
        targetLanguage: "en",
        workTitle: "Action",
      },
    );

    expect(block.fontFamily).toBe("bangers");
  });

  it("auto-selects vertical only for a one-column ordinary block", () => {
    const block = overlayItemToBlock(
      {
        id: 1,
        type: "nonsolid",
        textRole: "ordinary",
        bbox: { x: 100, y: 100, w: 25, h: 300 },
        jp: "縦書き",
        ko: "세로쓰기",
        direction: "vertical",
        fontSize: 20,
        confidence: 1,
      },
      makePage(),
      0,
      undefined,
      undefined,
      { enabled: true, locale: "ko" },
    );

    expect(block.renderDirection).toBe("vertical");
    expect(block.translatedText).toBe("세로쓰기");
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
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
