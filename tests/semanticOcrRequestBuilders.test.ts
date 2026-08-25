import { describe, expect, it } from "vitest";

const { buildSemanticStageRequestBody, resolveStructuredTokenBudget } =
  require("../src/main/runtime/transport/semantic-ocr-request-builders.cjs") as {
    buildSemanticStageRequestBody: (
      options: Record<string, unknown>,
      messages: unknown[],
      responseFormat: Record<string, unknown>,
      stage: "grouping" | "translation",
      unitCount: number,
    ) => Record<string, unknown>;
    resolveStructuredTokenBudget: (
      options: Record<string, unknown>,
      stage: "grouping" | "translation",
      unitCount: number,
    ) => { maxTokens: number; source: string };
  };

function maxTokens(
  options: Record<string, unknown>,
  stage: "grouping" | "translation",
  unitCount: number,
): number {
  return Number(
    buildSemanticStageRequestBody(options, [], {}, stage, unitCount).max_tokens,
  );
}

describe("semantic OCR structured output budgets", () => {
  it("keeps the compact grouping budget", () => {
    expect(maxTokens({ maxTokens: 32_768 }, "grouping", 5)).toBe(512);
  });

  it("reserves a generous first-pass translation and page-context budget", () => {
    expect(
      maxTokens(
        {
          maxTokens: 32_768,
          collectPageContext: true,
          translationAttempt: 1,
          workContextBudget: {
            effective: { outputHeadroomTokens: 40_000 },
          },
        },
        "translation",
        5,
      ),
    ).toBe(17_408);
    expect(
      maxTokens(
        {
          maxTokens: 32_768,
          collectPageContext: false,
          translationAttempt: 1,
        },
        "translation",
        5,
      ),
    ).toBe(9_216);
  });

  it("doubles retries without exceeding configured or actual headroom", () => {
    expect(
      maxTokens(
        {
          maxTokens: 32_768,
          collectPageContext: true,
          translationAttempt: 2,
          workContextBudget: {
            effective: { outputHeadroomTokens: 40_000 },
          },
        },
        "translation",
        5,
      ),
    ).toBe(32_768);
    expect(
      maxTokens(
        {
          maxTokens: 32_768,
          collectPageContext: true,
          translationAttempt: 2,
          workContextBudget: {
            effective: { outputHeadroomTokens: 12_000 },
          },
        },
        "translation",
        5,
      ),
    ).toBe(12_000);
  });

  it("uses the configured context window when no work-context snapshot exists", () => {
    expect(
      maxTokens(
        {
          maxTokens: 32_768,
          ctx: 16_384,
          collectPageContext: true,
          translationAttempt: 1,
        },
        "translation",
        3,
      ),
    ).toBe(9_984);
  });

  it("distinguishes configured output, work-context, and local context caps", () => {
    expect(
      resolveStructuredTokenBudget(
        { maxTokens: 4096, ctx: 32_768, modelProvider: "openai-api" },
        "translation",
        5,
      ).source,
    ).toBe("max-output-tokens");
    expect(
      resolveStructuredTokenBudget(
        {
          maxTokens: 32_768,
          modelProvider: "openai-api",
          translationAttempt: 2,
          workContextBudget: {
            effective: { outputHeadroomTokens: 12_000 },
          },
        },
        "translation",
        5,
      ).source,
    ).toBe("work-context-budget");
    expect(
      resolveStructuredTokenBudget(
        {
          maxTokens: 32_768,
          modelProvider: "gemma",
          translationAttempt: 2,
          workContextBudget: {
            effective: { outputHeadroomTokens: 12_000 },
          },
        },
        "translation",
        5,
      ).source,
    ).toBe("context-length");
    expect(
      resolveStructuredTokenBudget(
        { maxTokens: 32_768, ctx: 65_536, modelProvider: "openai-api" },
        "translation",
        1,
      ).source,
    ).toBe("structured-request-budget");
  });
});
