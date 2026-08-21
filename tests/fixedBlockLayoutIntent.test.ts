import { describe, expect, it } from "vitest";

type FixedBlockLayoutIntentPlan = {
  version: 6;
  blocks: Array<ReturnType<typeof fixedBlock>>;
};

const fixed =
  require("../src/main/runtime/semantic-ocr/fixed-block-translation.cjs") as {
    buildFixedBlockOverlayPayload: (
      plan: FixedBlockLayoutIntentPlan,
      translations: { items: Array<Record<string, unknown>> },
    ) => { items: Array<Record<string, unknown>> };
    parseFixedBlockTranslationResponse: (
      raw: string,
      plan: FixedBlockLayoutIntentPlan,
      options?: Record<string, unknown>,
    ) => { items: Array<Record<string, unknown>> };
    parseFixedBlockTranslationPartialResponse: (
      raw: string,
      plan: FixedBlockLayoutIntentPlan,
      options?: Record<string, unknown>,
    ) => {
      translations: { items: Array<Record<string, unknown>> };
      retryBlockIds: string[];
      horizontalFallbackTranslations?: {
        items: Array<Record<string, unknown>>;
      };
    };
    buildFixedBlockTranslationPrompt: (
      plan: FixedBlockLayoutIntentPlan,
      options: Record<string, unknown>,
    ) => string;
  };
const formats =
  require("../src/main/runtime/semantic-ocr/response-formats.cjs") as {
    buildFixedBlockTranslationResponseFormat: (
      ids: string[],
      options?: Record<string, unknown>,
    ) => Record<string, unknown>;
  };

const plan: FixedBlockLayoutIntentPlan = {
  version: 6 as const,
  blocks: [fixedBlock("B001", 1, "右"), fixedBlock("B002", 2, "左")],
};

describe("fixed-block layout intent compatibility", () => {
  it("requires the advisory enum in new responses and strongly defaults to horizontal rendering", () => {
    const response = formats.buildFixedBlockTranslationResponseFormat(
      ["B001"],
      { autoFontMatching: true },
    ) as {
      schema: {
        properties: {
          items: {
            items: {
              required: string[];
              properties: {
                layoutIntent: { enum: string[]; description: string };
                fontRoleConfidence: { description: string };
              };
            };
          };
        };
      };
    };
    const itemSchema = response.schema.properties.items.items;
    expect(itemSchema.required).toContain("layoutIntent");
    expect(itemSchema.properties.layoutIntent.enum).toEqual([
      "auto",
      "horizontal",
      "vertical",
    ]);
    expect(itemSchema.properties.layoutIntent.description).toContain(
      "fontRoleConfidence >= 0.82",
    );
    expect(itemSchema.properties.fontRoleConfidence.description).toContain(
      ">= 0.82",
    );
    const withoutRoleEvidence =
      formats.buildFixedBlockTranslationResponseFormat([
        "B001",
      ]) as typeof response;
    expect(
      withoutRoleEvidence.schema.properties.items.items.properties.layoutIntent
        .enum,
    ).toEqual(["auto", "horizontal"]);

    const prompt = fixed.buildFixedBlockTranslationPrompt(plan, {
      sourceLanguage: "ja",
      targetLanguage: "ko",
      autoFontMatching: true,
    });
    expect(prompt).toContain('Use layoutIntent "horizontal" by default');
    expect(prompt).toContain('Use layoutIntent "vertical" extremely sparingly');
    expect(prompt).toContain("outer edge of the manga page");
    expect(prompt).toContain("finite fontRoleConfidence >= 0.82");
    expect(prompt).toContain("never changes source direction, bbox, grouping");
  });

  it("accepts explicit auto and forwards only a concrete ordinary advisory", () => {
    const translations = fixed.parseFixedBlockTranslationResponse(
      JSON.stringify({
        items: [
          {
            blockId: "B001",
            textRole: "ordinary",
            layoutIntent: "vertical",
            fontRole: "narration",
            fontRoleConfidence: 0.82,
            ko: "오른쪽 가장자리의 아주 긴 설명문입니다",
          },
          {
            blockId: "B002",
            textRole: "ordinary",
            layoutIntent: "auto",
            fontRole: "dialogue",
            fontRoleConfidence: 0.8,
            ko: "왼쪽",
          },
        ],
      }),
      plan,
      { autoFontMatching: true },
    );

    expect(translations.items[0]?.layoutIntent).toBe("vertical");
    expect(translations.items[1]).not.toHaveProperty("layoutIntent");
    const payload = fixed.buildFixedBlockOverlayPayload(plan, translations);
    expect(payload.items[0]).toMatchObject({
      textRole: "ordinary",
      layoutIntent: "vertical",
    });
    expect(payload.items[1]).not.toHaveProperty("layoutIntent");
  });

  it("keeps missing legacy intent compatible but retries an explicitly invalid value", () => {
    const legacy = fixed.parseFixedBlockTranslationResponse(
      JSON.stringify({
        items: [
          { blockId: "B001", textRole: "ordinary", ko: "오른쪽" },
          { blockId: "B002", textRole: "ordinary", ko: "왼쪽" },
        ],
      }),
      plan,
    );
    expect(legacy.items).toHaveLength(2);
    expect(legacy.items[0]).not.toHaveProperty("layoutIntent");

    const invalidResponse = JSON.stringify({
      items: [
        {
          blockId: "B001",
          textRole: "ordinary",
          layoutIntent: "horizontal",
          ko: "오른쪽",
        },
        {
          blockId: "B002",
          textRole: "ordinary",
          layoutIntent: "diagonal",
          ko: "왼쪽",
        },
      ],
    });
    expect(() =>
      fixed.parseFixedBlockTranslationResponse(invalidResponse, plan),
    ).toThrowError(
      expect.objectContaining({
        code: "fixed-block-translation-layout-intent-invalid",
      }),
    );
    const partial = fixed.parseFixedBlockTranslationPartialResponse(
      invalidResponse,
      plan,
    );
    expect(partial).toMatchObject({
      translations: { items: [{ blockId: "B001" }] },
      retryBlockIds: ["B002"],
    });
    expect(partial).not.toHaveProperty("horizontalFallbackTranslations");
  });

  it("targets a v6 vertical advisory whose visual role is not narration", () => {
    const options = { autoFontMatching: true };
    const inconsistent = JSON.stringify({
      items: [
        {
          blockId: "B001",
          textRole: "ordinary",
          layoutIntent: "vertical",
          fontRole: "dialogue",
          fontRoleConfidence: 0.99,
          ko: "오른쪽 대사",
        },
        {
          blockId: "B002",
          textRole: "ordinary",
          layoutIntent: "horizontal",
          fontRole: "narration",
          fontRoleConfidence: 0.95,
          ko: "왼쪽 설명",
        },
      ],
    });

    expect(() =>
      fixed.parseFixedBlockTranslationResponse(inconsistent, plan, options),
    ).toThrowError(
      expect.objectContaining({
        code: "fixed-block-translation-layout-intent-font-role-conflict",
      }),
    );
    expect(
      fixed.parseFixedBlockTranslationPartialResponse(
        inconsistent,
        plan,
        options,
      ),
    ).toMatchObject({
      translations: { items: [{ blockId: "B002" }] },
      retryBlockIds: ["B001"],
      horizontalFallbackTranslations: {
        items: [
          {
            blockId: "B001",
            textRole: "ordinary",
            layoutIntent: "horizontal",
            fontRole: "dialogue",
            fontRoleConfidence: 0.99,
            ko: "오른쪽 대사",
          },
        ],
      },
    });

    const prompt = fixed.buildFixedBlockTranslationPrompt(plan, options);
    expect(prompt).toContain(
      'layoutIntent "vertical" is valid only when this same response has fontRole exactly "narration" and finite fontRoleConfidence >= 0.82',
    );
    expect(prompt).toContain("regardless of Japanese source orientation");
  });

  it("targets narration confidence below 0.82 and accepts the exact boundary", () => {
    const options = { autoFontMatching: true };
    const response = JSON.stringify({
      items: [
        {
          blockId: "B001",
          textRole: "ordinary",
          layoutIntent: "vertical",
          fontRole: "narration",
          fontRoleConfidence: 0.81,
          ko: "확신이 부족한 설명",
        },
        {
          blockId: "B002",
          textRole: "ordinary",
          layoutIntent: "vertical",
          fontRole: "narration",
          fontRoleConfidence: 0.82,
          ko: "경계값을 만족하는 설명",
        },
      ],
    });

    expect(() =>
      fixed.parseFixedBlockTranslationResponse(response, plan, options),
    ).toThrowError(
      expect.objectContaining({
        code: "fixed-block-translation-layout-intent-font-role-conflict",
      }),
    );
    expect(
      fixed.parseFixedBlockTranslationPartialResponse(response, plan, options),
    ).toMatchObject({
      translations: {
        items: [
          {
            blockId: "B002",
            layoutIntent: "vertical",
            fontRoleConfidence: 0.82,
          },
        ],
      },
      retryBlockIds: ["B001"],
      horizontalFallbackTranslations: {
        items: [
          {
            blockId: "B001",
            layoutIntent: "horizontal",
            fontRole: "narration",
            fontRoleConfidence: 0.81,
          },
        ],
      },
    });
  });

  it("targets vertical when automatic font evidence is disabled", () => {
    const response = JSON.stringify({
      items: [
        {
          blockId: "B001",
          textRole: "ordinary",
          layoutIntent: "vertical",
          ko: "역할 증거가 없는 설명",
        },
        {
          blockId: "B002",
          textRole: "ordinary",
          layoutIntent: "horizontal",
          ko: "일반 가로쓰기",
        },
      ],
    });

    expect(() =>
      fixed.parseFixedBlockTranslationResponse(response, plan),
    ).toThrowError(
      expect.objectContaining({
        code: "fixed-block-translation-layout-intent-font-role-conflict",
      }),
    );
    expect(
      fixed.parseFixedBlockTranslationPartialResponse(response, plan),
    ).toMatchObject({
      translations: { items: [{ blockId: "B002" }] },
      retryBlockIds: ["B001"],
      horizontalFallbackTranslations: {
        items: [
          {
            blockId: "B001",
            layoutIntent: "horizontal",
            ko: "역할 증거가 없는 설명",
          },
        ],
      },
    });

    const prompt = fixed.buildFixedBlockTranslationPrompt(plan, {});
    expect(prompt).toContain(
      'Never return "vertical" because this response has no current visual-role confidence evidence.',
    );
  });
});

function fixedBlock(blockId: string, id: number, jp: string) {
  return {
    blockId,
    representativeId: id,
    candidateIds: [id],
    directionVoterCandidateIds: [id],
    jp,
    bbox: { x1: id * 100, y1: 100, x2: id * 100 + 40, y2: 400 },
    direction: "vertical" as const,
    confidence: 0.9,
    soundCandidate: false,
    fragments: [],
  };
}
