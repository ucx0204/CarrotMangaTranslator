import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationOptions } from "../appSettings";
import type { ChapterRunPaths } from "../library";
import { logError, logInfo, logWarn } from "../logger";
import { classifyFailure, summarizePage } from "./failure";
import { summarizeTranslationOptions } from "./options";
import type { ProgressContext } from "./progressEvents";

export type PipelineDiagnostics = {
  info: (message: string, detail?: unknown) => void;
  warn: (message: string, detail?: unknown) => void;
  error: (message: string, detail?: unknown) => void;
};

const defaultDiagnostics: PipelineDiagnostics = {
  info: logInfo,
  warn: logWarn,
  error: logError,
};

export function logPipelineInfo(
  message: string,
  detail?: unknown,
  diagnostics: PipelineDiagnostics = defaultDiagnostics,
): void {
  diagnostics.info(message, detail);
}

export function logPipelineWarning(
  message: string,
  detail?: unknown,
  diagnostics: PipelineDiagnostics = defaultDiagnostics,
): void {
  diagnostics.warn(message, detail);
}

export function logAttemptFailure(
  {
    attempt,
    context,
    error,
    lastPageOptions,
    maxAttempts,
    page,
    pageIndex,
    runPaths,
  }: {
    attempt: number;
    context: ProgressContext;
    error: unknown;
    lastPageOptions: TranslationOptions;
    maxAttempts: number;
    page: MangaPage;
    pageIndex: number;
    runPaths: ChapterRunPaths;
  },
  diagnostics: PipelineDiagnostics = defaultDiagnostics,
): void {
  diagnostics.warn("Analysis attempt failed", {
    failureCategory: classifyFailure(error),
    jobId: context.jobId,
    page: summarizePage(page),
    pageIndex: pageIndex + 1,
    pageTotal: context.pageTotal,
    attempt,
    attemptTotal: maxAttempts,
    willRetry: attempt < maxAttempts,
    runPaths,
    pageOptions: summarizeTranslationOptions(lastPageOptions),
    error,
  });
}

export function logSkippedPage(
  {
    context,
    lastError,
    lastErrorMessage,
    lastPageOptions,
    maxAttempts,
    page,
    pageIndex,
    runPaths,
  }: {
    context: ProgressContext;
    lastError: unknown;
    lastErrorMessage: string;
    lastPageOptions: TranslationOptions | null;
    maxAttempts: number;
    page: MangaPage;
    pageIndex: number;
    runPaths: ChapterRunPaths;
  },
  diagnostics: PipelineDiagnostics = defaultDiagnostics,
): void {
  diagnostics.error("Analysis page skipped after retries", {
    failureCategory: classifyFailure(lastError),
    jobId: context.jobId,
    page: summarizePage(page),
    pageIndex: pageIndex + 1,
    pageTotal: context.pageTotal,
    attemptTotal: maxAttempts,
    runPaths,
    lastPageOptions: lastPageOptions
      ? summarizeTranslationOptions(lastPageOptions)
      : null,
    lastErrorMessage,
    error: lastError,
  });
}
