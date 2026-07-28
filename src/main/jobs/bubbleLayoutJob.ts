import type { StartInpaintingRequest } from "../../shared/inpaintingTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import type { AppSettings } from "../../shared/settingsTypes";
import {
  resolveBubbleLayoutPostprocessConfig,
  runBubbleLayoutPostprocess,
  type BubbleLayoutPostprocessConfig,
  type BubbleLayoutRunner,
} from "../inpainting/bubbleLayoutRunner";
import type { InpaintingJobContext } from "./inpaintingJobTypes";
import type { InpaintingJobRuntime } from "./inpaintingJobRuntime";

export type PreparedBubbleLayoutJob = {
  appSettings: AppSettings | null;
  config: BubbleLayoutPostprocessConfig | null;
  runner: BubbleLayoutRunner | null;
};

export async function prepareBubbleLayoutJob({
  context,
  request,
  runtime,
  totalTargetBlocks,
}: {
  context: InpaintingJobContext;
  request: StartInpaintingRequest;
  runtime: InpaintingJobRuntime;
  totalTargetBlocks: number;
}): Promise<PreparedBubbleLayoutJob> {
  if (totalTargetBlocks <= 0) {
    return { appSettings: null, config: null, runner: null };
  }
  const appSettings = await runtime.getSettings(context.appPaths);
  const config =
    request.mode === "page-bubble-layout"
      ? { policy: request.policy, overwriteManual: true }
      : resolveBubbleLayoutPostprocessConfig(request, appSettings);
  if (!config) {
    return { appSettings, config: null, runner: null };
  }
  if (!runtime.createBubbleLayoutRunner) {
    throw new Error("말풍선 배치 실행기를 사용할 수 없습니다.");
  }
  return {
    appSettings,
    config,
    runner: runtime.createBubbleLayoutRunner({
      dataRoot: context.appPaths.dataRoot,
      decodeFallback: context.decodeImage,
    }),
  };
}

export async function runBubbleLayoutOnlyPage({
  config,
  page,
  runner,
  signal,
}: {
  config: BubbleLayoutPostprocessConfig | null;
  page: MangaPage;
  runner: BubbleLayoutRunner | null;
  signal: AbortSignal;
}) {
  if (!config || !runner) {
    throw new Error("말풍선 배치 실행기를 사용할 수 없습니다.");
  }
  const processed = await runBubbleLayoutPostprocess({
    config,
    page,
    runner,
    signal,
  });
  return {
    ...processed,
    blocksErased: processed.afterLayout?.length ?? 0,
  };
}
