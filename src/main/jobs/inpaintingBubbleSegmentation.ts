import type { JobEvent } from "../../shared/jobTypes";
import type { BubbleDetectionMode } from "../../shared/inpaintingSettingsTypes";
import {
  acquireBubbleSegmentationEngine,
  type BubbleSegmentationEngineLease,
} from "../inpainting/bubbleSegmentationEnginePool";
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
  if (mode !== "precise") {
    return { lease: null, mode };
  }
  const lease = await acquireBubbleSegmentationEngine({
    appPaths: options.context.appPaths,
    backend: appSettings.inpainting?.koharuBackend ?? "auto",
    signal: options.abortController.signal,
    onProgress: (progress) =>
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
      }),
  });
  return { lease, mode };
}
