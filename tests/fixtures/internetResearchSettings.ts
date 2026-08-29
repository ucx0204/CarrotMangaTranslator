import type { InternetResearchSettings } from "../../src/shared/internetResearchTypes";

export const TEST_INTERNET_RESEARCH_SETTINGS: InternetResearchSettings = {
  tavilyAnalysisProvider: "gemma",
  gemmaPreset: "minimum12b",
  gemmaReasoningEffort: "medium",
  gemmaMaxOutputTokens: 32_768,
  gemmaContextTokens: 65_536,
  apiModel: "gpt-5.5",
  apiMaxOutputTokens: 32_768,
  apiContextTokens: 65_536,
  codexModel: "gpt-5.5",
  codexReasoningEffort: "low",
  codexMaxOutputTokens: 32_768,
  codexContextTokens: 65_536,
  tavilyMaxCreditsPerRun: 10,
};
