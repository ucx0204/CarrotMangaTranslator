import type { JobEvent } from "../../shared/jobTypes";
import type { BubbleDetectionMode } from "../../shared/inpaintingSettingsTypes";
import {
  acquireBubbleSegmentationEngine,
  type BubbleSegmentationEngineLease,
} from "../inpainting/bubbleSegmentationEnginePool";
import { acquireBubbleQualityRefiner } from "../inpainting/bubbleQualityRefinerPool";
import { logInpaintingRuntimeWarn } from "../inpainting/inpaintingRuntimeLogger";
import { getAppSettings } from "../settingsStore";
import type { InpaintingJobContext } from "./inpaintingJobTypes";

export async function prepareBubbleSegmentation(options: {
  abortController: AbortController;
  context: InpaintingJobContext;
  emit: (event: JobEvent) => void;
  id: string;
  pageCount: number;
  shouldPrepare: boolean;
}): Promise<{
  lease: BubbleSegmentationEngineLease | null;
  mode: BubbleDetectionMode;
}> {
  if (!options.shouldPrepare) {
    return { lease: null, mode: "auto" };
  }
  const appSettings = await getAppSettings(options.context.appPaths);
  const mode = appSettings.inpainting?.bubbleDetectionMode ?? "auto";
  if (mode === "auto") {
    return { lease: null, mode };
  }
  const lease = await acquireBubbleSegmentationEngine({
    appPaths: options.context.appPaths,
    backend: appSettings.inpainting?.koharuBackend ?? "auto",
    signal: options.abortController.signal,
    onProgress: (progress) => emitModelProgress(options, progress),
  });
  if (mode === "precise") {
    return { lease, mode };
  }
  try {
    const qualityLease = await acquireBubbleQualityRefiner({
      appPaths: options.context.appPaths,
      backend: normalizePreparedBackend(lease.engine.backend),
      requestedModel: mode === "sam3-experimental" ? "sam3" : "sam2.1",
      signal: options.abortController.signal,
      onProgress: (progress) => emitModelProgress(options, progress),
    });
    return {
      lease: {
        engine: lease.engine,
        qualityRefiner: qualityLease.refiner,
        release: () => {
          qualityLease.release();
          lease.release();
        },
      },
      mode,
    };
  } catch (error) {
    logInpaintingRuntimeWarn(
      "Highest-quality bubble runtime unavailable; precise detection retained",
      { mode, error },
    );
    return { lease, mode };
  }
}

function emitModelProgress(
  options: {
    emit: (event: JobEvent) => void;
    id: string;
    pageCount: number;
  },
  progress: {
    progressText: string;
    detail?: string;
    progressMode?: "indeterminate" | "determinate" | "log-only";
    progressPercent?: number;
    progressBytes?: number;
    progressTotalBytes?: number;
    installLogLine?: string;
  },
): void {
  options.emit({
    id: options.id,
    kind: "inpainting",
    status: "starting",
    progressText: progress.progressText,
    phase: "model_downloading",
    progressCurrent: 0,
    progressTotal: options.pageCount,
    pageTotal: options.pageCount,
    detail: progress.detail,
    progressMode: progress.progressMode,
    progressPercent: progress.progressPercent,
    progressBytes: progress.progressBytes,
    progressTotalBytes: progress.progressTotalBytes,
    installLogLine: progress.installLogLine,
  });
}

function normalizePreparedBackend(
  backend: string,
): "cuda-native" | "zluda-native" | "metal-native" | "cpu" {
  return ["cuda-native", "zluda-native", "metal-native"].includes(backend)
    ? (backend as "cuda-native" | "zluda-native" | "metal-native")
    : "cpu";
}
