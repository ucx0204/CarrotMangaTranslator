import { describe, expect, it } from "vitest";

const {
  normalizeItems,
  normalizeRegionSingleItem,
  parseJsonLenient,
  parseRegionSingleItem,
} = require("../src/main/runtime/overlay-parser.cjs");

describe("overlay parser", () => {
  it("parses strict line records with corner coordinates", () => {
    const raw = String.raw`
id: 1
type: solid
textRole: speech
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
type: nonsolid
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
    expect(items[0].textRole).toBe("ordinary");
    expect(items[0].direction).toBe("vertical");
    expect(items[0].fontSize).toBe(24);
    expect(items[0].confidence).toBe(0.83);
    expect(items[1].type).toBe("nonsolid");
    expect(items[1].bbox).toEqual({ x: 720, y: 700, w: 90, h: 120 });
  });

  it("normalizes fine-grained V2 font intent in loose records", () => {
    const raw = String.raw`
id: 1
type: nonsolid
textRole: sound
fontRole: sfx-impact
fontRoleConfidence: 97%
visual_cluster_id: repeated-impact-1
x1: 120
y1: 80
x2: 280
y2: 320
jp: ドン
ko: 쾅!
`;

    const items = normalizeItems(parseJsonLenient(raw));

    expect(items[0]).toMatchObject({
      fontRole: "sfx_impact",
      fontRoleConfidence: 0.97,
      visualClusterId: "repeated-impact-1",
    });
    expect(items[0]).not.toHaveProperty("visual_cluster_id");
  });

  it("migrates snake-case visual cluster ids to the canonical field", () => {
    const items = normalizeItems({
      items: [
        {
          id: 1,
          type: "nonsolid",
          visual_cluster_id: "  repeat－impact  ",
          x1: 10,
          y1: 20,
          x2: 110,
          y2: 80,
          jp: "ドン",
          ko: "쾅",
        },
      ],
    });

    expect(items[0].visualClusterId).toBe("repeat-impact");
    expect(items[0]).not.toHaveProperty("visual_cluster_id");
  });

  it("drops unsafe or unusable visual cluster ids without dropping text", () => {
    const invalidIds = [
      "   ",
      "x".repeat(201),
      "../other-cluster",
      "hidden\u0000cluster",
      "hidden\u202ecluster",
    ];
    const items = normalizeItems({
      items: invalidIds.map((visualClusterId, index) => ({
        id: index + 1,
        type: "nonsolid",
        visualClusterId,
        x1: 10,
        y1: 20 + index * 100,
        x2: 110,
        y2: 80 + index * 100,
        jp: "ドン",
        ko: "쾅",
      })),
    });

    expect(items).toHaveLength(invalidIds.length);
    expect(
      items.every((item: Record<string, unknown>) => !item.visualClusterId),
    ).toBe(true);
  });

  it("does not promote an out-of-range font role confidence", () => {
    const items = normalizeItems(
      parseJsonLenient(
        JSON.stringify({
          items: [
            {
              id: 1,
              type: "nonsolid",
              textRole: "sound",
              fontRole: "sfx_impact",
              fontRoleConfidence: 999,
              x1: 10,
              y1: 20,
              x2: 110,
              y2: 80,
              jp: "ドン",
              ko: "쾅!",
            },
          ],
        }),
      ),
    );

    expect(items[0]).not.toHaveProperty("fontRole");
    expect(items[0]).not.toHaveProperty("fontRoleConfidence");
  });

  it("keeps reserved font-role tokens inside loose ko text", () => {
    const items = normalizeItems(
      parseJsonLenient(
        "id: 1 type: nonsolid textRole: ordinary x1: 10 y1: 20 x2: 110 y2: 80 jp: 案内 ko: 안내 fontRole: sfx_impact fontRoleConfidence: 1",
      ),
    );

    expect(items[0]).toMatchObject({
      ko: "안내 fontRole: sfx_impact fontRoleConfidence: 1",
      textRole: "ordinary",
    });
    expect(items[0]).not.toHaveProperty("fontRole");
    expect(items[0]).not.toHaveProperty("fontRoleConfidence");
  });

  it("drops contradictory text and font roles from normalized JSON", () => {
    const items = normalizeItems({
      items: [
        {
          id: 1,
          type: "nonsolid",
          textRole: "ordinary",
          fontRole: "sfx_impact",
          fontRoleConfidence: 1,
          x1: 10,
          y1: 20,
          x2: 110,
          y2: 80,
          jp: "案内",
          ko: "안내",
        },
      ],
    });

    expect(items[0]).not.toHaveProperty("fontRole");
    expect(items[0]).not.toHaveProperty("fontRoleConfidence");
  });

  it("parses line records that use the neutral source/target keys", () => {
    const raw = String.raw`
id: 1
type: nonsolid
textRole: ordinary
x1: 120
y1: 80
x2: 280
y2: 320
direction: horizontal
angle: 0
fontSize: 24
confidence: 0.9
source: What are you doing here?
target: Qu'est-ce que tu fais ici ?
`;

    const parsed = parseJsonLenient(raw);
    const items = normalizeItems(parsed);

    expect(items).toHaveLength(1);
    expect(items[0].jp).toBe("What are you doing here?");
    expect(items[0].ko).toBe("Qu'est-ce que tu fais ici ?");
    expect(items[0].sourceText).toBe("What are you doing here?");
    expect(items[0].translatedText).toBe("Qu'est-ce que tu fais ici ?");
  });

  it("parses JSON records with source/target and sourceText/translatedText keys", () => {
    const fromSourceTarget = normalizeItems(
      parseJsonLenient(
        JSON.stringify({
          items: [
            {
              id: 1,
              type: "nonsolid",
              x1: 10,
              y1: 20,
              x2: 110,
              y2: 220,
              source: "Hello",
              target: "Bonjour",
            },
          ],
        }),
      ),
    );
    const fromNeutralNames = normalizeItems(
      parseJsonLenient(
        JSON.stringify({
          items: [
            {
              id: 2,
              type: "nonsolid",
              x1: 10,
              y1: 20,
              x2: 110,
              y2: 220,
              sourceText: "犬",
              translatedText: "개",
            },
          ],
        }),
      ),
    );

    expect(fromSourceTarget[0].jp).toBe("Hello");
    expect(fromSourceTarget[0].ko).toBe("Bonjour");
    expect(fromNeutralNames[0].jp).toBe("犬");
    expect(fromNeutralNames[0].ko).toBe("개");
    expect(fromNeutralNames[0].translatedText).toBe("개");
  });

  it("keeps parsing legacy jp/ko records with neutral aliases mirrored", () => {
    const items = normalizeItems(
      parseJsonLenient(
        JSON.stringify({
          items: [
            {
              id: 1,
              type: "nonsolid",
              x1: 1,
              y1: 2,
              x2: 30,
              y2: 40,
              jp: "こんにちは",
              ko: "안녕하세요",
            },
          ],
        }),
      ),
    );

    expect(items[0].jp).toBe("こんにちは");
    expect(items[0].ko).toBe("안녕하세요");
    expect(items[0].sourceText).toBe("こんにちは");
    expect(items[0].translatedText).toBe("안녕하세요");
  });

  it("normalizes reversed corner order and decimal coordinates", () => {
    const raw = String.raw`
id: 1
type: nonsolid
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
      "type": "solid",
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
      "type": "solid",
      "bbox": { "x": 420, "y": 600, "w": 160, "h": 150 },
      "jp": "違和感はないか？",
      "ko": "위화감은 없고?"
    },
    {
      "id": 2,
      "type": "solid",
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
type: nonsolid
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

  it("normalizes text roles and keeps sub-100 sound confidence below 1", () => {
    const items = normalizeItems(
      parseJsonLenient(String.raw`
id: 1
type: nonsolid
textRole: sfx
x1: 120
y1: 80
x2: 280
y2: 200
confidence: 99.9
jp: ザッ
ko: 잣

id: 2
type: nonsolid
textRole: caption
x1: 320
y1: 80
x2: 420
y2: 200
confidence: 1
jp: その日
ko: 그날
`),
    );

    expect(items).toHaveLength(2);
    expect(items[0].textRole).toBe("sound");
    expect(items[0].confidence).toBeLessThan(1);
    expect(items[1].textRole).toBe("ordinary");
  });

  it("preserves sparse model ids so OCR candidate geometry can stay locked", () => {
    const items = normalizeItems(
      parseJsonLenient(String.raw`
id: 6
type: solid
x1: 320
y1: 572
x2: 368
y2: 740
jp: 喜んで
ko: 기꺼이

id: 10
type: nonsolid
x1: 367
y1: 748
x2: 416
y2: 798
jp: ニコッ
ko: 생긋
`),
    );

    expect(items.map((item: { id: number }) => item.id)).toEqual([6, 10]);
  });

  it("strips leaked special tokens so blocks are not dropped or polluted", () => {
    const items = normalizeItems(
      parseJsonLenient(
        '{"items":[{"id":1,"x1":10,"y1":20,"x2":110,"y2":80,"jp":"日本","ko":"안녕<unused49>하세요"},{"id":2,"x1":120,"y1":90,"x2":200,"y2":160,"jp":"ドン","ko":"<unused3>쾅"}]}',
      ),
    );

    expect(items).toHaveLength(2);
    expect(items[0].ko).toBe("안녕하세요");
    expect(items[1].ko).toBe("쾅");
  });

  it("parses loose records when multiple key-value fields are on one line", () => {
    const items = normalizeItems(
      parseJsonLenient(
        "Result: id: 1 type: nonsolid textRole: ordinary x1: 10 y1: 20 x2: 110 y2: 80 jp: はい ko: 네 id: 2 type: solid x1: 120 y1: 90 x2: 200 y2: 160 jp: ドン ko: 쾅",
      ),
    );

    expect(items).toHaveLength(2);
    expect(items[0].bbox).toEqual({ x: 10, y: 20, w: 100, h: 60 });
    expect(items[1].bbox).toEqual({ x: 120, y: 90, w: 80, h: 70 });
  });

  it("parses selected-region single item JSON", () => {
    const items = normalizeRegionSingleItem(
      parseRegionSingleItem(
        JSON.stringify({
          item: {
            type: "nonsolid",
            textRole: "ordinary",
            x1: 10,
            y1: 20,
            x2: 110,
            y2: 160,
            direction: "vertical",
            angle: 0,
            fontSize: 24,
            confidence: 0.95,
            jp: "考えることが一緒だな！",
            ko: "생각하는 게 똑같네!",
          },
        }),
      ),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 1,
      type: "nonsolid",
      textRole: "ordinary",
      bbox: { x: 10, y: 20, w: 100, h: 140 },
      jp: "考えることが一緒だな！",
      ko: "생각하는 게 똑같네!",
    });
  });

  it("parses language-neutral selected-region keys", () => {
    const items = normalizeRegionSingleItem(
      parseRegionSingleItem(
        JSON.stringify({
          item: {
            type: "nonsolid",
            textRole: "ordinary",
            x1: 10,
            y1: 20,
            x2: 110,
            y2: 80,
            source: "What is it?",
            target: "Qu'est-ce que c'est ?",
          },
        }),
      ),
    );

    expect(items[0]).toMatchObject({
      jp: "What is it?",
      ko: "Qu'est-ce que c'est ?",
      sourceText: "What is it?",
      translatedText: "Qu'est-ce que c'est ?",
    });
  });

  it("parses selected-region null item as no text", () => {
    const items = normalizeRegionSingleItem(
      parseRegionSingleItem(JSON.stringify({ item: null })),
    );

    expect(items).toEqual([]);
  });

  it("accepts only the selected-region single item payload shape", () => {
    expect(() => parseRegionSingleItem("[]")).toThrow(
      /Region response contract violation/,
    );
    expect(() =>
      parseRegionSingleItem(JSON.stringify({ item: null, extra: true })),
    ).toThrow(/Region response contract violation/);
    expect(() =>
      parseRegionSingleItem(JSON.stringify({ text: "こんにちは" })),
    ).toThrow(/Region response contract violation/);
    expect(() =>
      parseRegionSingleItem(
        JSON.stringify({
          item: [],
        }),
      ),
    ).toThrow(/Region response contract violation/);
  });
});
