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

  it("keeps the existing remote-provider ceiling", () => {
    expect(
      resolveAnalysisOutputTokens({
        modelProvider: "openai-api",
        maxTokens: 32_768,
        ctx: 65_536,
      }),
    ).toBe(4096);
  });
});
