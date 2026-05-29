import { describe, expect, it } from "vitest";

const { normalizeItems, parseJsonLenient, parseRetryItems } = require("../src/main/runtime/overlay-parser.cjs");

describe("overlay parser", () => {
  it("parses strict line records with corner coordinates", () => {
    const raw = String.raw`
id: 1
type: dialogue
x1: 120
y1: 80
x2: 280
y2: 320
direction: vertical
angle: 0
fontSize: 24
confidence: 0.83
jp: 馬鹿者… 無理をするな
ko: 바보 같은 녀석… 무리하지 마라.

id: 2
type: name
x1: 720
y1: 700
x2: 810
y2: 820
jp: リッド
ko: 리드
`;

    const parsed = parseJsonLenient(raw);
    const items = normalizeItems(parsed);

    expect(items).toHaveLength(2);
    expect(items[0].bbox).toEqual({ x: 120, y: 80, w: 160, h: 240 });
    expect(items[0].direction).toBe("vertical");
    expect(items[0].fontSize).toBe(24);
    expect(items[0].confidence).toBe(0.83);
    expect(items[1].type).toBe("name");
    expect(items[1].bbox).toEqual({ x: 720, y: 700, w: 90, h: 120 });
  });

  it("normalizes reversed corner order and decimal coordinates", () => {
    const raw = String.raw`
id: 1
type: sfx
x1: 300.4
y1: 220.4
x2: 260.2
y2: 250.6
jp: ドン
ko: 쾅
`;

    const parsed = parseJsonLenient(raw);
    const items = normalizeItems(parsed);

    expect(items).toHaveLength(1);
    expect(items[0].bbox).toEqual({ x: 260, y: 220, w: 40, h: 30 });
  });

  it("parses JSON records with top-level corner coordinates", () => {
    const parsed = parseJsonLenient(String.raw`
{
  "items": [
    {
      "id": 1,
      "type": "dialogue",
      "x1": 10,
      "y1": 20,
      "x2": 110,
      "y2": 220,
      "jp": "はい",
      "ko": "네"
    }
  ]
}
`);
    const items = normalizeItems(parsed);

    expect(items).toHaveLength(1);
    expect(items[0].bbox).toEqual({ x: 10, y: 20, w: 100, h: 200 });
  });

  it("rejects old x/y/w/h and nested bbox records so bad model output is not hidden", () => {
    const parsed = parseJsonLenient(String.raw`
{
  "items": [
    {
      "id": 1,
      "type": "dialogue",
      "bbox": { "x": 420, "y": 600, "w": 160, "h": 150 },
      "jp": "違和感はないか？",
      "ko": "위화감은 없고?"
    },
    {
      "id": 2,
      "type": "dialogue",
      "x": 120,
      "y": 80,
      "w": 160,
      "h": 240,
      "jp": "これ",
      "ko": "이거"
    }
  ]
}
`);
    const items = normalizeItems(parsed);

    expect(items).toHaveLength(0);
  });

  it("normalizes direction, angle, and source font size fields", () => {
    const parsed = parseJsonLenient(String.raw`
id: 1
type: sfx
x1: 120
y1: 80
x2: 280
y2: 200
direction: vertical
angle: -42.4
fontSize: 28.6
jp: ザッ
ko: 삭
`);
    const items = normalizeItems(parsed);

    expect(items).toHaveLength(1);
    expect(items[0].direction).toBe("vertical");
    expect(items[0].angle).toBe(-30);
    expect(items[0].fontSize).toBe(29);
  });

  it("preserves sparse model ids so OCR candidate geometry can stay locked", () => {
    const items = normalizeItems(parseJsonLenient(String.raw`
id: 6
type: dialogue
x1: 320
y1: 572
x2: 368
y2: 740
jp: 喜んで
ko: 기꺼이

id: 10
type: sfx
x1: 367
y1: 748
x2: 416
y2: 798
jp: ニコッ
ko: 생긋
`));

    expect(items.map((item: { id: number }) => item.id)).toEqual([6, 10]);
  });

  it("parses crop retry records without bbox", () => {
    const items = parseRetryItems(String.raw`
id: 6
type: dialogue
direction: horizontal
angle: 0
fontSize: 22
confidence: 92
jp: ありがとう
ko: 고마워.

id: 9
type: reject
direction: horizontal
angle: 0
fontSize: 10
confidence: 1
jp: [non-text]
ko: [non-text]
`);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: 6,
      type: "dialogue",
      direction: "horizontal",
      angle: 0,
      fontSize: 22,
      confidence: 0.92,
      jp: "ありがとう",
      ko: "고마워."
    });
    expect(items[1].type).toBe("reject");
  });
});
