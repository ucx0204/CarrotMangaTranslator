import { describe, expect, it } from "vitest";
import {
  resolveAnalysisInputBudget,
  resolveAnalysisOutputTokens,
} from "../src/main/workContextAnalysisBudget";

describe("work context analysis output budget", () => {
  it("gives Gemma a large initial budget and doubles it for JSON repair", () => {
    const options = {
      modelProvider: "gemma" as const,
      maxTokens: 32_768,
      ctx: 65_536,
    };

    expect(resolveAnalysisOutputTokens(options, 1)).toBe(16_384);
    expect(resolveAnalysisOutputTokens(options, 2)).toBe(32_768);
  });

  it("caps Gemma output by both configured max tokens and context headroom", () => {
    expect(
      resolveAnalysisOutputTokens(
        { modelProvider: "gemma", maxTokens: 12_000, ctx: 65_536 },
        2,
      ),
    ).toBe(12_000);
    expect(
      resolveAnalysisOutputTokens(
        { modelProvider: "gemma", maxTokens: 32_768, ctx: 16_384 },
        2,
      ),
    ).toBe(13_384);
  });

  it("reserves enough context headroom for the larger JSON repair response", () => {
    const options = {
      modelProvider: "gemma" as const,
      maxTokens: 32_768,
      ctx: 65_536,
    };

    expect(resolveAnalysisInputBudget({ options })).toBe(63_536);
    expect(
      Math.ceil(resolveAnalysisInputBudget({ options }) / 2) +
        resolveAnalysisOutputTokens(options, 2) +
        1000,
    ).toBeLessThanOrEqual(options.ctx);
  });

  it("uses the configured remote output budget up to the analysis cap", () => {
    expect(
      resolveAnalysisOutputTokens({
        modelProvider: "openai-api",
        maxTokens: 32_768,
        ctx: 65_536,
      }),
    ).toBe(32_768);
    expect(
      resolveAnalysisOutputTokens({
        modelProvider: "openai-api",
        maxTokens: 12_000,
        ctx: 65_536,
      }),
    ).toBe(12_000);
    expect(
      resolveAnalysisOutputTokens({
        modelProvider: "openai-api",
        maxTokens: 128_000,
        ctx: 16_384,
      }),
    ).toBe(13_384);
  });

  it("derives remote input capacity from the configured context and output headroom", () => {
    const options = {
      modelProvider: "openai-api" as const,
      maxTokens: 32_768,
      ctx: 262_144,
    };

    expect(resolveAnalysisInputBudget({ options })).toBe(456_752);
    expect(
      Math.ceil(resolveAnalysisInputBudget({ options }) / 2) +
        resolveAnalysisOutputTokens(options, 2) +
        1000,
    ).toBeLessThanOrEqual(options.ctx);
  });

  it("preserves smaller input overrides and clamps unsafe overrides", () => {
    const options = {
      modelProvider: "openai-api" as const,
      maxTokens: 32_768,
      ctx: 65_536,
    };

    expect(resolveAnalysisInputBudget({ options, override: 12_000 })).toBe(
      12_000,
    );
    expect(resolveAnalysisInputBudget({ options, override: 500_000 })).toBe(
      63_536,
    );
  });

  it("honors the published context ceiling for a known remote model", () => {
    const options = {
      modelProvider: "openai-codex" as const,
      codexModel: "gpt-5.3-codex-spark",
      maxTokens: 128_000,
      ctx: 1_000_000,
    };

    expect(resolveAnalysisOutputTokens(options)).toBe(32_768);
    expect(resolveAnalysisInputBudget({ options })).toBe(188_464);
  });

  it("uses the larger Gemini work budget without exceeding its published window", () => {
    const recommendedOptions = {
      modelProvider: "openai-api" as const,
      apiModel: "gemini-3.5-flash-lite",
      maxTokens: 65_536,
      ctx: 524_288,
    };

    expect(resolveAnalysisOutputTokens(recommendedOptions)).toBe(32_768);
    expect(resolveAnalysisInputBudget({ options: recommendedOptions })).toBe(
      981_040,
    );
    expect(
      resolveAnalysisInputBudget({
        options: { ...recommendedOptions, ctx: 2_000_000 },
      }),
    ).toBe(2_029_616);
  });
});
