import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fixed = require(
  join(
    process.cwd(),
    "src",
    "main",
    "runtime",
    "semantic-ocr",
    "fixed-block-response.cjs",
  ),
) as {
  parseFixedBlockTranslationResponse: (
    rawText: string,
    plan: { blocks: Array<{ blockId: string }> },
    options: Record<string, unknown>,
  ) => unknown;
  parseFixedBlockTranslationPartialResponse: (
    rawText: string,
    plan: { blocks: Array<{ blockId: string }> },
    options: Record<string, unknown>,
  ) => {
    translations: { items: Array<{ blockId: string }> };
    retryBlockIds: string[];
    horizontalFallbackTranslations?: { items: Array<{ blockId: string }> };
  };
};

const plan = { blocks: [{ blockId: "B001" }, { blockId: "B002" }] };
const options = {
  sourceLanguage: "ja",
  targetLanguage: "ko",
  autoFontMatching: true,
};

describe("Font Matching V2 intent validation", () => {
  it("rejects out-of-range role confidence instead of clamping it", () => {
    expect(() => parseResponse("sound", "sfx_impact", 999)).toThrow(
      /valid fontRole and fontRoleConfidence/i,
    );
  });

  it("rejects a font role that contradicts textRole", () => {
    expect(() => parseResponse("ordinary", "sfx_impact", 0.99)).toThrow(
      /fontRole conflicts with textRole/i,
    );
  });

  it("rejects a non-object page context", () => {
    expect(() =>
      fixed.parseFixedBlockTranslationResponse(
        JSON.stringify({
          items: makeValidItems(),
          pageContext: "not-an-object",
        }),
        plan,
        { ...options, collectPageContext: true },
      ),
    ).toThrow(/pageContext must be an object/i);
  });

  it("does not salvage a horizontal fallback that still leaks source script", () => {
    const result = fixed.parseFixedBlockTranslationPartialResponse(
      JSON.stringify({
        items: [
          {
            blockId: "B001",
            textRole: "ordinary",
            layoutIntent: "vertical",
            fontRole: "dialogue",
            fontRoleConfidence: 0.9,
            ko: "こんにちは",
          },
          makeValidItems()[1],
        ],
      }),
      plan,
      options,
    );

    expect(result.translations.items.map((item) => item.blockId)).toEqual([
      "B002",
    ]);
    expect(result.retryBlockIds).toEqual(["B001"]);
    expect(result.horizontalFallbackTranslations).toBeUndefined();
  });

  it("keeps a malformed horizontal retry out of the salvage result", () => {
    const result = fixed.parseFixedBlockTranslationPartialResponse(
      JSON.stringify({
        items: [
          {
            blockId: "B001",
            textRole: "ordinary",
            layoutIntent: "vertical",
            fontRole: "dialogue",
            fontRoleConfidence: 0.9,
            ko: "두 줄\n번역",
          },
          makeValidItems()[1],
        ],
      }),
      plan,
      options,
    );

    expect(result.retryBlockIds).toEqual(["B001"]);
    expect(result.horizontalFallbackTranslations).toBeUndefined();
  });
});

function makeValidItems() {
  return [
    {
      blockId: "B001",
      textRole: "ordinary",
      fontRole: "dialogue",
      fontRoleConfidence: 0.9,
      ko: "그래.",
    },
    {
      blockId: "B002",
      textRole: "ordinary",
      fontRole: "dialogue",
      fontRoleConfidence: 0.9,
      ko: "좋아.",
    },
  ];
}

function parseResponse(
  textRole: "ordinary" | "sound",
  fontRole: string,
  fontRoleConfidence: number,
) {
  return fixed.parseFixedBlockTranslationResponse(
    JSON.stringify({
      items: [
        {
          blockId: "B001",
          textRole,
          fontRole,
          fontRoleConfidence,
          ko: "쾅!",
        },
        {
          blockId: "B002",
          textRole: "ordinary",
          fontRole: "dialogue",
          fontRoleConfidence: 0.9,
          ko: "그래.",
        },
      ],
    }),
    plan,
    options,
  );
}
