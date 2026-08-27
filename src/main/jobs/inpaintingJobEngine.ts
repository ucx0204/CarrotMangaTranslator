import type { AppSettings } from "../../shared/settingsTypes";
import type { JobEvent } from "../../shared/jobTypes";
import type { InpaintingJobContext } from "./inpaintingJobTypes";
import type { InpaintingJobRuntime } from "./inpaintingJobRuntime";

type InpaintingEngineLease = Awaited<
  ReturnType<InpaintingJobRuntime["acquireEngine"]>
>;

export async function acquireInpaintingEngineIfNeeded({
  abortController,
  appSettings,
  context,
  emit,
  id,
  shouldAcquireEngine,
  pageCount,
  totalTargetBlocks,
  runtime,
}: {
  abortController: AbortController;
  appSettings: AppSettings | null;
  context: InpaintingJobContext;
  emit: (event: JobEvent) => void;
  id: string;
  shouldAcquireEngine: boolean;
  pageCount: number;
  totalTargetBlocks: number;
  runtime: InpaintingJobRuntime;
}): Promise<InpaintingEngineLease | null> {
  if (!shouldAcquireEngine || totalTargetBlocks <= 0 || !appSettings) {
    return null;
  }
  return runtime.acquireEngine({
    appPaths: context.appPaths,
    model: appSettings.inpainting?.model ?? "flux-klein",
    fluxBackend: appSettings.inpainting?.fluxBackend,
    koharuBackend: appSettings.inpainting?.koharuBackend,
    computeGpuIndex: appSettings.hardware?.computeGpuIndex,
    allowUnsafeLowMemoryFlux:
      appSettings.inpainting?.allowUnsafeLowMemoryFlux ?? false,
    signal: abortController.signal,
    onProgress: (progress) =>
      emit({
        id,
        kind: "inpainting",
        status: "starting",
        progressText: progress.progressText,
        phase: "model_downloading",
        progressCurrent: 0,
        progressTotal: pageCount,
        pageTotal: pageCount,
        detail: progress.detail,
        progressMode: progress.progressMode,
        progressPercent: progress.progressPercent,
        progressBytes: progress.progressBytes,
        progressTotalBytes: progress.progressTotalBytes,
        installLogLine: progress.installLogLine,
      }),
  });
}
