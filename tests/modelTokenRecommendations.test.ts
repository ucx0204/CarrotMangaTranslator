import { describe, expect, it } from "vitest";
import {
  DEFAULT_GEMMA_CONTEXT_TOKENS,
  DEFAULT_GEMMA_MAX_TOKENS,
  DEFAULT_REMOTE_CONTEXT_TOKENS,
  DEFAULT_REMOTE_MAX_TOKENS,
  findCodexModelPreset,
  resolveRecommendedGenerationLimits,
} from "../src/shared/modelPresets";

describe("model token recommendations", () => {
  it("keeps public Codex ceilings separate from working defaults", () => {
    const sol = findCodexModelPreset("gpt-5.6-sol");

    expect(sol).toMatchObject({
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
      recommendedContextTokens: DEFAULT_REMOTE_CONTEXT_TOKENS,
      recommendedMaxTokens: DEFAULT_REMOTE_MAX_TOKENS,
    });
  });

  it("uses the documented Spark context without inventing an output ceiling", () => {
    expect(findCodexModelPreset("gpt-5.3-codex-spark")).toMatchObject({
      contextWindowTokens: 128_000,
      maxOutputTokens: null,
      recommendedContextTokens: DEFAULT_REMOTE_CONTEXT_TOKENS,
      recommendedMaxTokens: 24_576,
    });
  });

  it("uses local-safe Gemma values and conservative unknown remote values", () => {
    expect(resolveRecommendedGenerationLimits("gemma")).toEqual({
      contextTokens: DEFAULT_GEMMA_CONTEXT_TOKENS,
      contextWindowTokens: null,
      maxOutputTokens: null,
      maxTokens: DEFAULT_GEMMA_MAX_TOKENS,
    });
    expect(
      resolveRecommendedGenerationLimits("openai-codex", "future-codex-model"),
    ).toEqual({
      contextTokens: DEFAULT_REMOTE_CONTEXT_TOKENS,
      contextWindowTokens: null,
      maxOutputTokens: null,
      maxTokens: DEFAULT_REMOTE_MAX_TOKENS,
    });
    expect(
      resolveRecommendedGenerationLimits("openai-api", "gpt-5.6-sol"),
    ).toEqual({
      contextTokens: DEFAULT_REMOTE_CONTEXT_TOKENS,
      contextWindowTokens: null,
      maxOutputTokens: null,
      maxTokens: DEFAULT_REMOTE_MAX_TOKENS,
    });
  });
});
