import type { StartInpaintingRequest } from "../../shared/inpaintingTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import type { AppSettings } from "../../shared/settingsTypes";
import { resolveBubbleLayoutPaddingRatio } from "../../shared/bubbleLayoutPadding";
import {
  isGeneratedBubbleLayout,
  isManualBubbleLayout,
  isUsableBubbleLayout,
} from "../../shared/bubbleLayout";
import {
  resolveBubbleLayoutPostprocessConfig,
  runBubbleLayoutPostprocess,
  type BubbleLayoutPostprocessConfig,
  type BubbleLayoutRunner,
} from "../inpainting/bubbleLayoutRunner";
import {
  captureInpaintingLayoutStates,
  type InpaintingBlockLayoutState,
} from "../inpainting/inpaintingLayoutState";
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
      ? {
          policy: request.policy,
          paddingRatio: resolveBubbleLayoutPaddingRatio(
            appSettings.inpainting?.bubbleLayoutPaddingRatio,
          ),
          overwriteManual: true,
        }
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
  blockId,
  config,
  page,
  runner,
  signal,
}: {
  blockId?: string;
  config: BubbleLayoutPostprocessConfig | null;
  page: MangaPage;
  runner: BubbleLayoutRunner | null;
  signal: AbortSignal;
}) {
  if (!config || !runner) {
    throw new Error("말풍선 배치 실행기를 사용할 수 없습니다.");
  }
  const processed = await runBubbleLayoutPostprocess({
    blockId,
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

/**
 * Builds transient, unpadded Bubble geometry for the Flux mask only.
 *
 * The returned layout must never be committed. `restoreLayout` contains the
 * exact pre-pass baseline needed to remove transient geometry from the
 * inpainting result before the configured, persisted postprocess runs.
 */
export async function runBubbleLayoutMaskPrepass({
  blockId,
  config,
  page,
  runner,
  signal,
}: {
  blockId?: string;
  config: BubbleLayoutPostprocessConfig;
  page: MangaPage;
  runner: BubbleLayoutRunner;
  signal: AbortSignal;
}): Promise<{
  bubbleLayoutConstraintBlockIds: string[];
  page: MangaPage;
  restoreLayout?: InpaintingBlockLayoutState[];
}> {
  const blockIds = blockId ? [blockId] : page.blocks.map((block) => block.id);
  const restoreLayout = captureInpaintingLayoutStates(page, blockIds);
  const maskBaselinePage: MangaPage = {
    ...page,
    blocks: page.blocks.map((block) => {
      if (
        (blockId === undefined || block.id === blockId) &&
        isGeneratedBubbleLayout(block.bubbleLayout)
      ) {
        const withoutPersistedLayout = { ...block };
        delete withoutPersistedLayout.bubbleLayout;
        delete withoutPersistedLayout.renderBbox;
        delete withoutPersistedLayout.renderBboxSpace;
        return withoutPersistedLayout;
      }
      return block;
    }),
  };
  const processed = await runBubbleLayoutPostprocess({
    blockId,
    config: {
      policy: config.policy,
      // Inpainting uses the detector's raw safe region. User-configured
      // padding is render-only and is applied by the final postprocess.
      paddingRatio: 0,
      overwriteManual: false,
    },
    page: maskBaselinePage,
    runner,
    signal,
  });
  const bubbleLayoutConstraintBlockIds = new Set(
    page.blocks
      .filter(
        (block) =>
          (blockId === undefined || block.id === blockId) &&
          isManualBubbleLayout(block.bubbleLayout) &&
          isUsableBubbleLayout(block.bubbleLayout),
      )
      .map((block) => block.id),
  );
  for (const state of processed.afterLayout ?? []) {
    if (isUsableBubbleLayout(state.bubbleLayout)) {
      bubbleLayoutConstraintBlockIds.add(state.blockId);
    }
  }
  return {
    bubbleLayoutConstraintBlockIds: [...bubbleLayoutConstraintBlockIds],
    page: processed.page,
    ...(restoreLayout.length ? { restoreLayout } : {}),
  };
}
