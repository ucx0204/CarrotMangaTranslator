import type { AppSettings } from "../../shared/settingsTypes";
import { getAppPaths, type AppPaths } from "../appPaths";
import { saveChapterStoryMemory, saveWorkStyleGuide } from "../library";
import { logError, logInfo, logWarn } from "../logger";
import { getAppSettings } from "../settingsStore";
import { loadTranslationRuntimePort } from "../translationRuntime";
import type { PageContextPersistenceRepository } from "./pageContextPersistence";
import type { PipelineDiagnostics } from "./translationAttemptLogging";
import type { TranslationRuntimePort } from "./translationRuntimePort";
import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import { resolveUiLocale } from "../../shared/uiLocales";
import { loadBuiltInFontMatchingCandidates } from "../builtInFontMatchingCatalog";
import { loadCustomFontMatchingCandidates } from "../customFontMatchingCatalog";

type PipelineSettingsRepository = {
  getAppSettings: (paths: AppPaths) => Promise<AppSettings>;
};

export type WholePagePipelineDependencies = {
  paths: AppPaths;
  settings: PipelineSettingsRepository;
  fontMatching: {
    loadCandidates: (
      targetLanguage?: string,
    ) => readonly AutomaticFontCandidate[];
  };
  pageContext: PageContextPersistenceRepository;
  diagnostics: PipelineDiagnostics;
  runtime: TranslationRuntimePort;
};

export function createDefaultWholePagePipelineDependencies(): WholePagePipelineDependencies {
  return {
    paths: getAppPaths(),
    settings: { getAppSettings },
    fontMatching: {
      loadCandidates: (targetLanguage) => {
        const locale = resolveUiLocale(targetLanguage);
        if (!locale) return [];
        return [
          ...loadBuiltInFontMatchingCandidates(locale, logWarn),
          ...loadCustomFontMatchingCandidates(logWarn),
        ];
      },
    },
    pageContext: { saveChapterStoryMemory, saveWorkStyleGuide },
    diagnostics: {
      info: logInfo,
      warn: logWarn,
      error: logError,
    },
    runtime: loadTranslationRuntimePort(),
  };
}

export function safelyLoadFontMatchingCandidates(
  dependencies: WholePagePipelineDependencies,
  targetLanguage?: string,
): readonly AutomaticFontCandidate[] {
  try {
    return dependencies.fontMatching.loadCandidates(targetLanguage);
  } catch (error) {
    dependencies.diagnostics.warn(
      "Automatic font matching catalog could not be loaded",
      error,
    );
    return [];
  }
}
