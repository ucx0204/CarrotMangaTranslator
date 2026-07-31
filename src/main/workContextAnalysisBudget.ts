import type { TranslationOptions } from "./appSettings";

const MAX_ANALYSIS_OUTPUT_TOKENS = 4096;
const GEMMA_ANALYSIS_BASE_OUTPUT_TOKENS = 16_384;
const GEMMA_ANALYSIS_REPAIR_OUTPUT_SCALE = 2;
const MIN_ANALYSIS_OUTPUT_TOKENS = 256;
const ANALYSIS_PROMPT_OVERHEAD_TOKENS = 1000;
const CHARS_PER_TOKEN_ESTIMATE = 2;
const DEFAULT_API_ANALYSIS_INPUT_CHARS = 64_000;
const MIN_ANALYSIS_INPUT_CHARS = 4_000;

type AnalysisBudgetOptions = Pick<
  TranslationOptions,
  "modelProvider" | "maxTokens" | "ctx"
>;

export function resolveAnalysisInputBudget({
  options,
  override,
}: {
  options: AnalysisBudgetOptions;
  override?: number;
}): number {
  if (override) {
    return override;
  }
  if (options.modelProvider === "gemma") {
    const availableTokens = Math.max(
      1000,
      options.ctx -
        resolveAnalysisOutputTokens(options, 2) -
        ANALYSIS_PROMPT_OVERHEAD_TOKENS,
    );
    return Math.max(
      MIN_ANALYSIS_INPUT_CHARS,
      availableTokens * CHARS_PER_TOKEN_ESTIMATE,
    );
  }
  return DEFAULT_API_ANALYSIS_INPUT_CHARS;
}

export function resolveAnalysisOutputTokens(
  options: AnalysisBudgetOptions,
  attempt = 1,
): number {
  const configuredMax = Math.max(
    MIN_ANALYSIS_OUTPUT_TOKENS,
    Math.trunc(options.maxTokens),
  );
  if (options.modelProvider !== "gemma") {
    return Math.min(configuredMax, MAX_ANALYSIS_OUTPUT_TOKENS);
  }

  const minimumInputTokens = Math.ceil(
    MIN_ANALYSIS_INPUT_CHARS / CHARS_PER_TOKEN_ESTIMATE,
  );
  const contextHeadroom = Math.max(
    MIN_ANALYSIS_OUTPUT_TOKENS,
    Math.trunc(options.ctx) -
      ANALYSIS_PROMPT_OVERHEAD_TOKENS -
      minimumInputTokens,
  );
  const retryScale =
    Math.max(1, Math.trunc(attempt)) >= 2
      ? GEMMA_ANALYSIS_REPAIR_OUTPUT_SCALE
      : 1;
  const requested = GEMMA_ANALYSIS_BASE_OUTPUT_TOKENS * retryScale;
  return Math.min(configuredMax, contextHeadroom, requested);
}
