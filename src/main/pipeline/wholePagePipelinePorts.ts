import type { AppSettings } from "../../shared/settingsTypes";
import { getAppPaths, type AppPaths } from "../appPaths";
import { saveChapterStoryMemory, saveWorkStyleGuide } from "../library";
import { logError, logInfo, logWarn } from "../logger";
import { getAppSettings } from "../settingsStore";
import { loadTranslationRuntimePort } from "../translationRuntime";
import type { PageContextPersistenceRepository } from "./pageContextPersistence";
import type { PipelineDiagnostics } from "./translationAttemptLogging";
import type { TranslationRuntimePort } from "./translationRuntimePort";

type PipelineSettingsRepository = {
  getAppSettings: (paths: AppPaths) => Promise<AppSettings>;
};

export type WholePagePipelineDependencies = {
  paths: AppPaths;
  settings: PipelineSettingsRepository;
  pageContext: PageContextPersistenceRepository;
  diagnostics: PipelineDiagnostics;
  runtime: TranslationRuntimePort;
};

export function createDefaultWholePagePipelineDependencies(): WholePagePipelineDependencies {
  return {
    paths: getAppPaths(),
    settings: { getAppSettings },
    pageContext: { saveChapterStoryMemory, saveWorkStyleGuide },
    diagnostics: {
      info: logInfo,
      warn: logWarn,
      error: logError,
    },
    runtime: loadTranslationRuntimePort(),
  };
}
