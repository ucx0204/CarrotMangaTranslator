import { ipcEventContracts } from "../../shared/ipcContracts";
import type { ModelTestProgressEvent } from "../../shared/jobTypes";
import type { TranslationOptions } from "../appSettings";
import { logInfo } from "../logger";
import type { SimplePageRuntime } from "../simplePageRuntime";
import { tMain } from "./localization";
import { isHayaiOcrPipeline } from "../../shared/ocrEngines";

export type SendModelTestProgress = (
  progress: Omit<ModelTestProgressEvent, "id">,
) => void;

export type ModelTestProgressEventSource = {
  sender: {
    send: (channel: string, payload: unknown) => void;
  };
};

export function createModelTestProgressSender(
  event: ModelTestProgressEventSource,
  testId: string,
): SendModelTestProgress {
  return (progress) => {
    const payload = {
      id: testId,
      ...progress,
    } satisfies ModelTestProgressEvent;
    event.sender.send(
      ipcEventContracts.modelTestProgress.channel,
      ipcEventContracts.modelTestProgress.payload.parse(payload),
    );
    logInfo(
      "Settings model/runtime check progress",
      summarizeModelTestProgress(payload),
    );
  };
}

export function sendEnginePreparationProgress(
  runtime: SimplePageRuntime,
  options: TranslationOptions,
  sendProgress: SendModelTestProgress,
): void {
  if (options.modelProvider === "openai-codex") {
    sendProgress({
      phase: "booting",
      progressText: tMain("modelTest.codexPreparing"),
      detail: options.codexModel,
      installLogLine: tMain("modelTest.codexPreparingLog"),
    });
    return;
  }
  if (options.modelProvider === "openai-api") {
    sendProgress({
      phase: "booting",
      progressText: tMain("modelTest.apiPreparing"),
      detail: `${options.apiModel} @ ${options.apiBaseUrl}`,
      installLogLine: tMain("modelTest.apiPreparingLog"),
    });
    return;
  }

  sendGemmaPreparationProgress(runtime, options, sendProgress);
}

export async function verifyOcrRuntime(
  runtime: SimplePageRuntime,
  options: TranslationOptions,
  sendProgress: SendModelTestProgress,
): Promise<void> {
  const ocrPipeline = options.ocrPipeline;
  const hayai = isHayaiOcrPipeline(ocrPipeline);
  sendProgress({
    phase: "ocr_preparing",
    ocrPipeline,
    progressText: tMain(
      hayai ? "modelTest.hayaiOcrChecking" : "modelTest.ocrChecking",
    ),
    progressMode: "indeterminate",
    installLogLine: tMain(
      hayai ? "modelTest.hayaiOcrCheckingLog" : "modelTest.ocrCheckingLog",
    ),
  });

  const ocrRuntime = await runtime.ensureOcrRuntime(options);
  const detail = [ocrRuntime.runtimeVariant, ocrRuntime.pythonPath]
    .filter(Boolean)
    .join(" · ");
  sendProgress({
    phase: "ocr_preparing",
    ocrPipeline,
    progressText: tMain(hayai ? "modelTest.hayaiOcrDone" : "modelTest.ocrDone"),
    ...(detail ? { detail } : {}),
    progressMode: "determinate",
    progressPercent: 1,
    installLogLine: tMain(
      hayai ? "modelTest.hayaiOcrDoneLog" : "modelTest.ocrDoneLog",
    ),
  });
}

function summarizeModelTestProgress(
  progress: ModelTestProgressEvent,
): Record<string, unknown> {
  return {
    id: progress.id,
    phase: progress.phase,
    ocrPipeline: progress.ocrPipeline,
    progressText: progress.progressText,
    detail: progress.detail,
    progressMode: progress.progressMode,
    progressPercent: progress.progressPercent,
    progressBytes: progress.progressBytes,
    progressTotalBytes: progress.progressTotalBytes,
    progressBytesPerSecond: progress.progressBytesPerSecond,
    installLogLine: progress.installLogLine,
    notification: progress.notification,
  };
}

function sendGemmaPreparationProgress(
  runtime: SimplePageRuntime,
  options: TranslationOptions,
  sendProgress: SendModelTestProgress,
): void {
  sendProgress({
    phase: "booting",
    progressText: tMain("modelTest.gemmaPreparing"),
    detail:
      options.modelSource === "local"
        ? options.localModelPath
        : `${options.modelRepo} / ${options.modelFile}`,
    progressMode: "indeterminate",
    installLogLine: tMain("modelTest.gemmaPreparingLog"),
  });
  if (runtime.isModelCached(options)) {
    sendProgress({
      phase: "booting",
      progressText: tMain("modelTest.gemmaCached"),
      detail: options.modelFile,
      installLogLine: tMain("modelTest.gemmaCachedLog"),
    });
    return;
  }
  sendProgress({
    phase: "model_downloading",
    progressText: tMain("modelTest.gemmaDownloading"),
    detail: `${options.modelRepo} / ${options.modelFile}`,
    progressMode: "log-only",
    installLogLine: tMain("modelTest.gemmaDownloadingLog"),
  });
}
