import type { TranslationOptions } from "../appSettings";
import { getAppPaths, type AppPaths } from "../appPaths";
import { getAppSettings } from "../settingsStore";
import type { AppSettings, MangaPage } from "../../shared/types";
import { logInfo } from "../logger";
import { buildBaseOptions, summarizeTranslationOptions } from "./options";
import {
  attachBaseProgress,
  emitOcrPreparation,
  type ProgressContext,
} from "./progressEvents";
import {
  loadTranslationRuntimePort,
  type TranslationRuntimePort,
} from "./translationRuntimePort";
import type { ChapterRunPaths } from "../library";
import type { PipelineOptions } from "./types";

export type AnalysisRun = {
  paths: AppPaths;
  appSettings: AppSettings;
  runtime: TranslationRuntimePort;
  baseOptions: TranslationOptions;
  progressContext: ProgressContext;
  codexSelected: boolean;
  apiSelected: boolean;
  modelCached: boolean;
  localModelSelected: boolean;
};

export async function prepareAnalysisRun({
  jobId,
  emit,
  pages,
  runPaths,
  signal,
  skipOcrPrepass,
}: {
  jobId: string;
  emit: PipelineOptions["emit"];
  pages: MangaPage[];
  runPaths: ChapterRunPaths;
  signal: AbortSignal;
  skipOcrPrepass: boolean;
}): Promise<AnalysisRun> {
  const paths = getAppPaths();
  const appSettings = await getAppSettings(paths);
  const runtime = loadTranslationRuntimePort();
  const baseOptions = buildBaseOptions(
    jobId,
    runPaths.runDir,
    appSettings,
    paths,
  );
  const codexSelected = baseOptions.modelProvider === "openai-codex";
  const apiSelected = baseOptions.modelProvider === "openai-api";
  const remoteProviderSelected = codexSelected || apiSelected;
  const modelCached =
    remoteProviderSelected || runtime.isModelCached(baseOptions);
  const localModelSelected =
    !remoteProviderSelected && baseOptions.modelSource === "local";
  const progressContext = {
    jobId,
    emit,
    progressTotal: pages.length,
    pageTotal: pages.length,
  };

  logInfo("Analysis pipeline initialized", {
    jobId,
    pageCount: pages.length,
    runPaths,
    modelCached,
    settings: summarizeTranslationOptions(baseOptions),
  });

  emitOcrPreparation(progressContext, skipOcrPrepass);
  attachBaseProgress(progressContext, baseOptions);
  baseOptions.abortSignal = signal;

  return {
    paths,
    appSettings,
    runtime,
    baseOptions,
    progressContext,
    codexSelected,
    apiSelected,
    modelCached,
    localModelSelected,
  };
}
