import { ipcEventContracts } from "../../shared/ipcContracts";
import type { ModelTestProgressEvent } from "../../shared/jobTypes";
import type { TranslationOptions } from "../appSettings";
import { logInfo } from "../logger";
import type { SimplePageRuntime } from "../simplePageRuntime";

export type SendModelTestProgress = (
  progress: Omit<ModelTestProgressEvent, "id">,
) => void;

export function createModelTestProgressSender(
  event: Electron.IpcMainInvokeEvent,
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
      progressText: "OpenAI Codex 런타임 엔드포인트 준비 중",
      detail: `${options.codexModel}, port ${options.codexOauthPort}`,
      installLogLine: "openai-oauth 엔드포인트를 시작합니다.",
    });
    return;
  }
  if (options.modelProvider === "openai-api") {
    sendProgress({
      phase: "booting",
      progressText: "API 엔드포인트 확인 중",
      detail: `${options.apiModel} @ ${options.apiBaseUrl}`,
      installLogLine:
        "OpenAI 호환 API 엔드포인트로 직접 테스트 요청을 보냅니다.",
    });
    return;
  }

  sendGemmaPreparationProgress(runtime, options, sendProgress);
}

export async function verifyPaddleOcrRuntime(
  runtime: SimplePageRuntime,
  options: Record<string, unknown>,
  sendProgress: SendModelTestProgress,
): Promise<void> {
  sendProgress({
    phase: "ocr_preparing",
    progressText: "Paddle OCR 설치/작동 확인 중",
    progressMode: "indeterminate",
    installLogLine: "Paddle OCR 런타임과 OCR 모델 파일을 확인합니다.",
  });

  if (!runtime.ensurePaddleOcrRuntime) {
    sendProgress({
      phase: "ocr_preparing",
      progressText: "Paddle OCR 확인 건너뜀",
      detail: "현재 런타임이 OCR 사전 확인 API를 제공하지 않습니다.",
      installLogLine:
        "Paddle OCR 사전 확인 API가 없어 번역 엔진 확인만 진행합니다.",
    });
    return;
  }

  const ocrRuntime = await runtime.ensurePaddleOcrRuntime(options);
  const detail = [ocrRuntime.runtimeVariant, ocrRuntime.pythonPath]
    .filter(Boolean)
    .join(" · ");
  sendProgress({
    phase: "ocr_preparing",
    progressText: "Paddle OCR 확인 완료",
    ...(detail ? { detail } : {}),
    progressMode: "determinate",
    progressPercent: 1,
    installLogLine: "Paddle OCR 런타임 확인이 끝났습니다.",
  });
}

function summarizeModelTestProgress(
  progress: ModelTestProgressEvent,
): Record<string, unknown> {
  return {
    id: progress.id,
    phase: progress.phase,
    progressText: progress.progressText,
    detail: progress.detail,
    progressMode: progress.progressMode,
    progressPercent: progress.progressPercent,
    progressBytes: progress.progressBytes,
    progressTotalBytes: progress.progressTotalBytes,
    progressBytesPerSecond: progress.progressBytesPerSecond,
    installLogLine: progress.installLogLine,
  };
}

function sendGemmaPreparationProgress(
  runtime: SimplePageRuntime,
  options: TranslationOptions,
  sendProgress: SendModelTestProgress,
): void {
  sendProgress({
    phase: "booting",
    progressText: "Gemma 실행 런타임 준비 중",
    detail:
      options.modelSource === "local"
        ? options.localModelPath
        : `${options.modelRepo} / ${options.modelFile}`,
    progressMode: "indeterminate",
    installLogLine: "Gemma 실행 런타임과 모델 자산을 확인합니다.",
  });
  if (runtime.isModelCached(options)) {
    sendProgress({
      phase: "booting",
      progressText: "캐시된 Gemma 모델 확인됨",
      detail: options.modelFile,
      installLogLine: "캐시된 모델 파일을 사용합니다.",
    });
    return;
  }
  sendProgress({
    phase: "model_downloading",
    progressText: "Gemma 모델 다운로드/런타임 준비 중",
    detail: `${options.modelRepo} / ${options.modelFile}`,
    progressMode: "log-only",
    installLogLine: "캐시된 모델이 없어서 다운로드 또는 갱신을 시작합니다.",
  });
}
