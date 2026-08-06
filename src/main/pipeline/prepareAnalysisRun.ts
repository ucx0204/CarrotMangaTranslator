import type { TranslationOptions } from "../appSettings";
import type { AppPaths } from "../appPaths";
import type { AppSettings } from "../../shared/settingsTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import { buildBaseOptions, summarizeTranslationOptions } from "./options";
import {
  attachBaseProgress,
  emitOcrPreparation,
  type ProgressContext,
} from "./progressEvents";
import type { TranslationRuntimePort } from "./translationRuntimePort";
import type { ChapterRunPaths } from "../library";
import type { PipelineOptions } from "./types";
import type { WholePagePipelineDependencies } from "./wholePagePipelinePorts";
import { throwIfAborted } from "./failure";

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
  runtime,
  signal,
  skipOcrPrepass,
  dependencies,
}: {
  jobId: string;
  emit: PipelineOptions["emit"];
  pages: MangaPage[];
  runPaths: ChapterRunPaths;
  runtime: TranslationRuntimePort;
  signal: AbortSignal;
  skipOcrPrepass: boolean;
  dependencies: Pick<
    WholePagePipelineDependencies,
    "diagnostics" | "paths" | "settings"
  >;
}): Promise<AnalysisRun> {
  throwIfAborted(signal);
  const paths = dependencies.paths;
  const appSettings = await dependencies.settings.getAppSettings(paths);
  throwIfAborted(signal);
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

  dependencies.diagnostics.info("Analysis pipeline initialized", {
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
