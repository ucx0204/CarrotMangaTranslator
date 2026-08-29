import {
  DEFAULT_RESEARCH_API_CONTEXT_TOKENS,
  DEFAULT_RESEARCH_API_MAX_OUTPUT_TOKENS,
  DEFAULT_RESEARCH_CODEX_CONTEXT_TOKENS,
  DEFAULT_RESEARCH_CODEX_MAX_OUTPUT_TOKENS,
  DEFAULT_RESEARCH_GEMMA_CONTEXT_TOKENS,
  DEFAULT_RESEARCH_GEMMA_MAX_OUTPUT_TOKENS,
  DEFAULT_RESEARCH_GEMMA_PRESET,
  DEFAULT_RESEARCH_GEMMA_REASONING_EFFORT,
  DEFAULT_TAVILY_ANALYSIS_PROVIDER,
  DEFAULT_TAVILY_MAX_CREDITS_PER_RUN,
  MIN_TAVILY_MAX_CREDITS_PER_RUN,
  RESEARCH_GEMMA_REASONING_EFFORTS,
  RESEARCH_GEMMA_PRESETS,
  TAVILY_ANALYSIS_PROVIDERS,
  type InternetResearchSettings,
  type ResearchGemmaPreset,
  type ResearchGemmaReasoningEffort,
  type TavilyAnalysisProvider,
} from "../../shared/internetResearchTypes";
import type { AppSettings } from "../../shared/settingsTypes";
import {
  asRecord,
  resolveCodexReasoningEffort,
  resolveContextTokens,
  resolveMaxTokens,
  resolveNonEmptyString,
  resolveNumberRange,
  resolveOptionalString,
} from "./appSettingsResolvers";

export function resolveDefaultInternetResearchSettings(
  codex: AppSettings["codex"],
  api: AppSettings["api"],
): InternetResearchSettings {
  return {
    tavilyAnalysisProvider: DEFAULT_TAVILY_ANALYSIS_PROVIDER,
    gemmaPreset: DEFAULT_RESEARCH_GEMMA_PRESET,
    gemmaReasoningEffort: DEFAULT_RESEARCH_GEMMA_REASONING_EFFORT,
    gemmaMaxOutputTokens: DEFAULT_RESEARCH_GEMMA_MAX_OUTPUT_TOKENS,
    gemmaContextTokens: DEFAULT_RESEARCH_GEMMA_CONTEXT_TOKENS,
    apiModel: api.model,
    apiMaxOutputTokens: DEFAULT_RESEARCH_API_MAX_OUTPUT_TOKENS,
    apiContextTokens: DEFAULT_RESEARCH_API_CONTEXT_TOKENS,
    codexModel: codex.model,
    codexReasoningEffort: codex.reasoningEffort,
    codexMaxOutputTokens: DEFAULT_RESEARCH_CODEX_MAX_OUTPUT_TOKENS,
    codexContextTokens: DEFAULT_RESEARCH_CODEX_CONTEXT_TOKENS,
    tavilyMaxCreditsPerRun: DEFAULT_TAVILY_MAX_CREDITS_PER_RUN,
  };
}

export function normalizeInternetResearchSettings(
  raw: unknown,
  defaults: InternetResearchSettings,
): InternetResearchSettings {
  const record = asRecord(raw) ?? {};
  const tavilyApiKey = resolveOptionalString(record.tavilyApiKey);
  return {
    tavilyAnalysisProvider: resolveTavilyAnalysisProvider(
      record.tavilyAnalysisProvider,
      defaults.tavilyAnalysisProvider,
    ),
    gemmaPreset: resolveResearchGemmaPreset(
      record.gemmaPreset,
      defaults.gemmaPreset,
    ),
    gemmaReasoningEffort: resolveResearchGemmaReasoningEffort(
      record.gemmaReasoningEffort,
      defaults.gemmaReasoningEffort,
    ),
    gemmaMaxOutputTokens: resolveMaxTokens(
      record.gemmaMaxOutputTokens,
      defaults.gemmaMaxOutputTokens,
    ),
    gemmaContextTokens: resolveContextTokens(
      record.gemmaContextTokens,
      defaults.gemmaContextTokens,
    ),
    apiModel: resolveNonEmptyString(record.apiModel, defaults.apiModel),
    apiMaxOutputTokens: resolveMaxTokens(
      record.apiMaxOutputTokens,
      defaults.apiMaxOutputTokens,
    ),
    apiContextTokens: resolveContextTokens(
      record.apiContextTokens,
      defaults.apiContextTokens,
    ),
    codexModel: resolveNonEmptyString(record.codexModel, defaults.codexModel),
    codexReasoningEffort: resolveCodexReasoningEffort(
      record.codexReasoningEffort,
      defaults.codexReasoningEffort,
    ),
    codexMaxOutputTokens: resolveMaxTokens(
      record.codexMaxOutputTokens,
      defaults.codexMaxOutputTokens,
    ),
    codexContextTokens: resolveContextTokens(
      record.codexContextTokens,
      defaults.codexContextTokens,
    ),
    ...(tavilyApiKey ? { tavilyApiKey } : {}),
    tavilyMaxCreditsPerRun: Math.round(
      resolveNumberRange(
        record.tavilyMaxCreditsPerRun,
        defaults.tavilyMaxCreditsPerRun,
        MIN_TAVILY_MAX_CREDITS_PER_RUN,
        Number.MAX_SAFE_INTEGER,
      ),
    ),
  };
}

function resolveTavilyAnalysisProvider(
  value: unknown,
  fallback: TavilyAnalysisProvider,
): TavilyAnalysisProvider {
  return (
    TAVILY_ANALYSIS_PROVIDERS.find((candidate) => candidate === value) ??
    fallback
  );
}

function resolveResearchGemmaPreset(
  value: unknown,
  fallback: ResearchGemmaPreset,
): ResearchGemmaPreset {
  return (
    RESEARCH_GEMMA_PRESETS.find((candidate) => candidate === value) ?? fallback
  );
}

function resolveResearchGemmaReasoningEffort(
  value: unknown,
  fallback: ResearchGemmaReasoningEffort,
): ResearchGemmaReasoningEffort {
  return (
    RESEARCH_GEMMA_REASONING_EFFORTS.find((candidate) => candidate === value) ??
    fallback
  );
}
