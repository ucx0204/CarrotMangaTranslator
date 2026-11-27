import { DEFAULT_INPAINTING_MODEL } from "../../shared/inpaintingSettingsTypes";
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
  engine,
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
  engine?: "codex";
}): Promise<InpaintingEngineLease | null> {
  if (!shouldAcquireEngine || totalTargetBlocks <= 0 || !appSettings) {
    return null;
  }
  const codexEngine = resolveCodexEngine(runtime, engine);
  if (codexEngine) {
    return codexEngine(context.appPaths, appSettings, abortController.signal);
  }
  const inpainting = appSettings.inpainting ?? {};
  return runtime.acquireEngine({
    appPaths: context.appPaths,
    model: inpainting.model ?? DEFAULT_INPAINTING_MODEL,
    fluxBackend: inpainting.fluxBackend,
    fluxMode: inpainting.fluxMode,
    koharuBackend: inpainting.koharuBackend,
    computeGpuIndex: appSettings.hardware?.computeGpuIndex,
    allowUnsafeLowMemoryFlux: inpainting.allowUnsafeLowMemoryFlux ?? false,
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

function resolveCodexEngine(runtime: InpaintingJobRuntime, engine?: "codex") {
  if (engine !== "codex") return null;
  if (!runtime.acquireCodexEngine)
    throw new Error("Codex 원문 제거를 사용할 수 없습니다.");
  return runtime.acquireCodexEngine;
}
