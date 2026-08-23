import { describe, expect, it } from "vitest";
import {
  buildTranslatedTextImport,
  decodeImportedTextContent,
  formatGatheredText,
  type GatheredPage,
} from "../src/renderer/src/lib/gatherText";

const pages: GatheredPage[] = [
  {
    pageId: "p1",
    pageName: "a.png",
    index: 0,
    blocks: [
      { id: "b1", sourceText: "あ", translatedText: "안녕" },
      { id: "b2", sourceText: "い", translatedText: "잘가" },
    ],
  },
  {
    pageId: "p2",
    pageName: "b.png",
    index: 1,
    blocks: [{ id: "b3", sourceText: "う", translatedText: "고마워" }],
  },
];

describe("decodeImportedTextContent", () => {
  it("falls back to Windows-949 for files saved by Korean Windows apps", () => {
    const cp949Text = new Uint8Array([190, 200, 179, 231]).buffer;

    expect(decodeImportedTextContent(cp949Text)).toBe("안녕");
  });
});

describe("buildTranslatedTextImport", () => {
  it("round-trips the default OCR + Korean txt export", () => {
    const exported = formatGatheredText(pages, "both");

    const result = buildTranslatedTextImport(pages, exported);

    expect(result.warnings).toEqual([]);
    expect(result.matchedPageCount).toBe(2);
    expect(result.updates).toEqual([]);
  });

  it("imports changed Korean lines from the default OCR + Korean txt export", () => {
    const exported = formatGatheredText(pages, "both").replace(
      "안녕",
      "안녕하세요",
    );

    const result = buildTranslatedTextImport(pages, exported);

    expect(result.warnings).toEqual([]);
    expect(result.updates).toEqual([
      { pageId: "p1", blockId: "b1", translatedText: "안녕하세요" },
    ]);
  });

  it("maps lines to blocks in order and only reports changed lines", () => {
    const result = buildTranslatedTextImport(
      pages,
      [
        "# 1쪽 · a.png",
        "안녕하세요",
        "잘가",
        "",
        "# 2쪽 · b.png",
        "고마워",
      ].join("\n"),
    );
    expect(result.warnings).toEqual([]);
    expect(result.matchedPageCount).toBe(2);
    expect(result.updates).toEqual([
      { pageId: "p1", blockId: "b1", translatedText: "안녕하세요" },
    ]);
  });

  it("imports the new blank-line grouped translation format with multiline blocks", () => {
    const result = buildTranslatedTextImport(
      pages,
      [
        "# 1쪽 · a.png",
        "첫 번째 줄",
        "두 번째 줄",
        "",
        "새 잘가",
        "",
        "# 2쪽 · b.png",
        "새 고마워",
      ].join("\n"),
    );

    expect(result.warnings).toEqual([]);
    expect(result.updates).toEqual([
      {
        pageId: "p1",
        blockId: "b1",
        translatedText: "첫 번째 줄\n두 번째 줄",
      },
      { pageId: "p1", blockId: "b2", translatedText: "새 잘가" },
      { pageId: "p2", blockId: "b3", translatedText: "새 고마워" },
    ]);
  });

  it("skips pages whose line count does not match the block count", () => {
    const result = buildTranslatedTextImport(
      pages,
      ["# 1쪽 · a.png", "한 줄뿐", "", "# 2쪽 · b.png", "새 번역"].join("\n"),
    );
    expect(result.matchedPageCount).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("1쪽");
    expect(result.updates).toEqual([
      { pageId: "p2", blockId: "b3", translatedText: "새 번역" },
    ]);
  });

  it("warns for headers that do not match any page", () => {
    const result = buildTranslatedTextImport(
      pages,
      ["# 9쪽 · missing.png", "떠도는 줄"].join("\n"),
    );
    expect(result.updates).toEqual([]);
    expect(result.warnings[0]).toContain("9쪽");
  });

  it("accepts a headerless file only when exactly one page is shown", () => {
    const single = buildTranslatedTextImport([pages[1]], "고마워요");
    expect(single.updates).toEqual([
      { pageId: "p2", blockId: "b3", translatedText: "고마워요" },
    ]);

    const ambiguous = buildTranslatedTextImport(pages, "고마워요");
    expect(ambiguous.updates).toEqual([]);
    expect(ambiguous.warnings).toHaveLength(1);
  });

  it("reports an empty file", () => {
    const result = buildTranslatedTextImport(pages, "\n\n");
    expect(result.updates).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
});

describe("formatGatheredText", () => {
  it("separates every block with one blank line in all three modes", () => {
    expect(formatGatheredText(pages, "both")).toBe(
      [
        "# 1쪽 · a.png",
        "あ",
        "안녕",
        "",
        "い",
        "잘가",
        "",
        "# 2쪽 · b.png",
        "う",
        "고마워",
      ].join("\n"),
    );
    expect(formatGatheredText(pages, "translated")).toBe(
      ["# 1쪽 · a.png", "안녕", "", "잘가", "", "# 2쪽 · b.png", "고마워"].join(
        "\n",
      ),
    );
    expect(formatGatheredText(pages, "source")).toBe(
      ["# 1쪽 · a.png", "あ", "", "い", "", "# 2쪽 · b.png", "う"].join("\n"),
    );
  });

  it("preserves lines inside a block and separates only adjacent blocks", () => {
    const multiline: GatheredPage[] = [
      {
        ...pages[0],
        blocks: [
          { ...pages[0].blocks[0], translatedText: "첫 줄\n둘째 줄" },
          pages[0].blocks[1],
        ],
      },
    ];

    expect(formatGatheredText(multiline, "translated", false)).toBe(
      "첫 줄\n둘째 줄\n\n잘가",
    );
  });
});
