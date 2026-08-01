import type { TranslationOptions } from "./appSettings";
import { resolveRecommendedGenerationLimits } from "../shared/modelPresets";

// The analysis schema itself is bounded to glossary, character, and page-summary
// collections, so reserving more output than this only reduces useful input.
const ANALYSIS_STRUCTURED_JSON_OUTPUT_CAP_TOKENS = 32_768;
const GEMMA_ANALYSIS_BASE_OUTPUT_TOKENS = 16_384;
const GEMMA_ANALYSIS_REPAIR_OUTPUT_SCALE = 2;
const MIN_ANALYSIS_OUTPUT_TOKENS = 256;
const ANALYSIS_PROMPT_OVERHEAD_TOKENS = 1000;
const CHARS_PER_TOKEN_ESTIMATE = 2;
const MIN_ANALYSIS_INPUT_CHARS = 4_000;

type AnalysisBudgetOptions = Pick<
  TranslationOptions,
  "modelProvider" | "maxTokens" | "ctx"
> &
  Partial<Pick<TranslationOptions, "apiModel" | "codexModel">>;

export function resolveAnalysisInputBudget({
  options,
  override,
}: {
  options: AnalysisBudgetOptions;
  override?: number;
}): number {
  const availableTokens = Math.max(
    MIN_ANALYSIS_INPUT_CHARS / CHARS_PER_TOKEN_ESTIMATE,
    resolveAnalysisContextTokens(options) -
      resolveAnalysisOutputTokens(options, 2) -
      ANALYSIS_PROMPT_OVERHEAD_TOKENS,
  );
  const availableChars = Math.max(
    MIN_ANALYSIS_INPUT_CHARS,
    availableTokens * CHARS_PER_TOKEN_ESTIMATE,
  );
  if (override === undefined) {
    return availableChars;
  }
  return Math.min(
    availableChars,
    Math.max(MIN_ANALYSIS_INPUT_CHARS, Math.trunc(override)),
  );
}

export function resolveAnalysisOutputTokens(
  options: AnalysisBudgetOptions,
  attempt = 1,
): number {
  const configuredMax = Math.max(
    MIN_ANALYSIS_OUTPUT_TOKENS,
    Math.trunc(options.maxTokens),
  );
  const minimumInputTokens = Math.ceil(
    MIN_ANALYSIS_INPUT_CHARS / CHARS_PER_TOKEN_ESTIMATE,
  );
  const contextHeadroom = Math.max(
    MIN_ANALYSIS_OUTPUT_TOKENS,
    resolveAnalysisContextTokens(options) -
      ANALYSIS_PROMPT_OVERHEAD_TOKENS -
      minimumInputTokens,
  );
  const modelOutputLimit = resolveAnalysisModelLimits(options).maxOutputTokens;
  if (options.modelProvider !== "gemma") {
    return Math.min(
      configuredMax,
      contextHeadroom,
      modelOutputLimit ?? Number.POSITIVE_INFINITY,
      ANALYSIS_STRUCTURED_JSON_OUTPUT_CAP_TOKENS,
    );
  }

  const retryScale =
    Math.max(1, Math.trunc(attempt)) >= 2
      ? GEMMA_ANALYSIS_REPAIR_OUTPUT_SCALE
      : 1;
  const requested = GEMMA_ANALYSIS_BASE_OUTPUT_TOKENS * retryScale;
  return Math.min(configuredMax, contextHeadroom, requested);
}

function resolveAnalysisContextTokens(options: AnalysisBudgetOptions): number {
  const configuredContext = Math.max(1, Math.trunc(options.ctx));
  const modelContextLimit =
    resolveAnalysisModelLimits(options).contextWindowTokens;
  return modelContextLimit
    ? Math.min(configuredContext, modelContextLimit)
    : configuredContext;
}

function resolveAnalysisModelLimits(options: AnalysisBudgetOptions) {
  const model =
    options.modelProvider === "openai-codex"
      ? options.codexModel
      : options.modelProvider === "openai-api"
        ? options.apiModel
        : null;
  return resolveRecommendedGenerationLimits(options.modelProvider, model);
}
