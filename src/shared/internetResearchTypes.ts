import type { CodexReasoningEffort } from "./codexSettings";

export const RESEARCH_ENGINES = ["tavily", "codex-web"] as const;
export type ResearchEngine = (typeof RESEARCH_ENGINES)[number];

export const TAVILY_ANALYSIS_PROVIDERS = ["gemma", "api"] as const;
export type TavilyAnalysisProvider = (typeof TAVILY_ANALYSIS_PROVIDERS)[number];

export const RESEARCH_GEMMA_PRESETS = [
  "minimum12b",
  "qat12b",
  "economy26b",
  "qat26b",
  "full31b",
  "qat31b",
  "custom",
] as const;
export type ResearchGemmaPreset = (typeof RESEARCH_GEMMA_PRESETS)[number];

export const RESEARCH_GEMMA_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
] as const;
export type ResearchGemmaReasoningEffort =
  (typeof RESEARCH_GEMMA_REASONING_EFFORTS)[number];

export const DEFAULT_RESEARCH_ENGINE: ResearchEngine = "tavily";
export const DEFAULT_TAVILY_ANALYSIS_PROVIDER: TavilyAnalysisProvider = "gemma";
export const DEFAULT_RESEARCH_GEMMA_PRESET: ResearchGemmaPreset = "qat12b";
export const DEFAULT_RESEARCH_GEMMA_REASONING_EFFORT: ResearchGemmaReasoningEffort =
  "high";
export const DEFAULT_RESEARCH_GEMMA_MAX_OUTPUT_TOKENS = 32_768;
export const DEFAULT_RESEARCH_GEMMA_CONTEXT_TOKENS = 65_536;
export const DEFAULT_RESEARCH_API_MAX_OUTPUT_TOKENS = 32_768;
export const DEFAULT_RESEARCH_API_CONTEXT_TOKENS = 65_536;
export const DEFAULT_RESEARCH_CODEX_MAX_OUTPUT_TOKENS = 32_768;
export const DEFAULT_RESEARCH_CODEX_CONTEXT_TOKENS = 256 * 1_024;
export const DEFAULT_TAVILY_MAX_CREDITS_PER_RUN = 10;
export const MIN_TAVILY_MAX_CREDITS_PER_RUN = 5;

export type InternetResearchSettings = {
  tavilyAnalysisProvider: TavilyAnalysisProvider;
  gemmaPreset: ResearchGemmaPreset;
  gemmaReasoningEffort: ResearchGemmaReasoningEffort;
  gemmaMaxOutputTokens: number;
  gemmaContextTokens: number;
  apiModel: string;
  apiMaxOutputTokens: number;
  apiContextTokens: number;
  codexModel: string;
  codexReasoningEffort: CodexReasoningEffort;
  codexMaxOutputTokens: number;
  codexContextTokens: number;
  /** Stored only in the OS-encrypted settings vault. */
  tavilyApiKey?: string;
  tavilyMaxCreditsPerRun: number;
};

export type TavilyUsageSnapshot = {
  configured: boolean;
  key: {
    used: number;
    limit: number;
    remaining: number;
    searchUsed: number;
  } | null;
  account: {
    plan: string;
    used: number;
    limit: number;
    remaining: number;
    paygoUsed: number;
    paygoLimit: number;
  } | null;
  fetchedAt: string;
};

export type TavilyUsageRequest = {
  /** Omit, or pass the preserve sentinel, to use the encrypted stored key. */
  apiKey?: string;
  force?: boolean;
};
