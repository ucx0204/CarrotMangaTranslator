import { DEFAULT_INPAINTING_MODEL } from "../../shared/inpaintingSettingsTypes";
import {
  usesRegionInpainting,
  type InpaintingModel,
} from "../../shared/inpaintingSettingsTypes";
import type { InpaintingWindowMask } from "../inpainting/inpaintingEngine";
import type { StartInpaintingRequest } from "../../shared/inpaintingTypes";
import type {
  MangaPage,
  TranslationCompletionWorkflow,
} from "../../shared/libraryTypes";
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
import type { KoharuTypographySegmentation } from "../bubbleLayout/contracts";
import { isBubbleLayoutBlockEligible } from "../bubbleLayout/bubbleLayoutBlockEligibility";
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
  completionWorkflow,
  context,
  request,
  runtime,
  totalTargetBlocks,
}: {
  completionWorkflow?: TranslationCompletionWorkflow;
  context: InpaintingJobContext;
  request: StartInpaintingRequest;
  runtime: InpaintingJobRuntime;
  totalTargetBlocks: number;
}): Promise<PreparedBubbleLayoutJob> {
  if (totalTargetBlocks <= 0) {
    return { appSettings: null, config: null, runner: null };
  }
  const appSettings = await runtime.getSettings(context.appPaths);
  const config = resolveJobBubbleLayoutConfig(
    request,
    appSettings,
    completionWorkflow,
  );
  const needsFluxMask = needsFluxMaskPrepass(request, appSettings);
  if (!config && (!needsFluxMask || !runtime.createBubbleLayoutRunner)) {
    return { appSettings, config: null, runner: null };
  }
  if (!runtime.createBubbleLayoutRunner) {
    throw new Error("말풍선 배치 실행기를 사용할 수 없습니다.");
  }
  return {
    appSettings,
    config,
    runner: runtime.createBubbleLayoutRunner({
      ...((appSettings.inpainting?.model ?? DEFAULT_INPAINTING_MODEL) ===
        "qwen-image-2.1" && { prepareQwenContext: true }),
      dataRoot: context.appPaths.dataRoot,
      decodeFallback: context.decodeImage,
      directMl: {
        ...appSettings.hardware,
        computeGpuBackend:
          appSettings.ocr.device === "gpu"
            ? (appSettings.ocr.gpuBackend ?? "cuda")
            : undefined,
      },
    }),
  };
}

export async function prepareBubbleLayoutPages(
  prepared: PreparedBubbleLayoutJob,
  request: StartInpaintingRequest,
  pages: readonly MangaPage[],
  signal: AbortSignal,
  onProgress: (page: MangaPage, index: number) => void,
): Promise<void> {
  if (
    prepared.appSettings &&
    needsFluxMaskPrepass(request, prepared.appSettings)
  )
    await prepared.runner?.preparePages?.(pages, signal, onProgress);
}

function needsFluxMaskPrepass(
  request: StartInpaintingRequest,
  settings: AppSettings,
): boolean {
  return (
    request.mode !== "page-pattern-drawn" &&
    request.mode !== "page-bubble-layout" &&
    !("engine" in request && request.engine === "codex") &&
    usesRegionInpainting(settings.inpainting?.model ?? DEFAULT_INPAINTING_MODEL)
  );
}

function resolveJobBubbleLayoutConfig(
  request: StartInpaintingRequest,
  appSettings: AppSettings,
  completionWorkflow: TranslationCompletionWorkflow | undefined,
): BubbleLayoutPostprocessConfig | null {
  if (request.mode === "page-bubble-layout") {
    return {
      policy: request.policy,
      paddingRatioOverride: request.paddingRatio,
      paddingRatio: resolveBubbleLayoutPaddingRatio(
        appSettings.inpainting?.bubbleLayoutPaddingRatio,
      ),
      overwriteManual: true,
    };
  }
  const configured = resolveBubbleLayoutPostprocessConfig(request, appSettings);
  if (request.postprocess?.bubbleLayout) return configured;
  if (completionWorkflow === "erase-original") return null;
  if (configured || completionWorkflow !== "bubble-layout") return configured;
  return {
    policy: "balanced",
    paddingRatio: resolveBubbleLayoutPaddingRatio(
      appSettings.inpainting?.bubbleLayoutPaddingRatio,
    ),
    overwriteManual: false,
  };
}

export async function runBubbleLayoutOnlyPage({
  blockId,
  blockIds,
  config,
  page,
  runner,
  signal,
}: {
  blockId?: string;
  blockIds?: readonly string[];
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
    blockIds,
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
  blockIds,
  config,
  model,
  page,
  runner,
  signal,
}: {
  blockId?: string;
  blockIds?: readonly string[];
  config: BubbleLayoutPostprocessConfig;
  model?: InpaintingModel | "codex";
  page: MangaPage;
  runner: BubbleLayoutRunner;
  signal: AbortSignal;
}): Promise<ReturnType<typeof buildMaskPrepassResult>> {
  const targetBlockIds = resolvePrepassBlockIds(page, blockId, blockIds);
  const targetBlockIdSet = new Set(targetBlockIds);
  // Workflow callers pass explicit ids even when selecting the whole page.
  // Only missing owners require a protective gutter between selected blocks.
  const hasSubset =
    blockId !== undefined ||
    page.blocks.some(
      (block) =>
        isBubbleLayoutBlockEligible(block) && !targetBlockIdSet.has(block.id),
    );
  const restoreLayout = captureInpaintingLayoutStates(page, targetBlockIds);
  const maskBaselinePage: MangaPage = {
    ...page,
    blocks: page.blocks.map((block) => {
      if (
        targetBlockIdSet.has(block.id) &&
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
    ...(blockId === undefined && blockIds ? { blockIds } : {}),
    config: {
      policy: config.policy,
      // Inpainting uses the detector's raw safe region. User-configured
      // padding is render-only and is applied by the final postprocess.
      paddingRatio: 0,
      // Full-page Flux receives each shared balloon as one grouped region.
      // A one-block retry must keep the normal ownership split so it cannot
      // erase source text owned by a neighboring block.
      sharedOwnershipGapPx: hasSubset ? undefined : 0,
      overwriteManual: false,
    },
    failureMode: "best-effort",
    includeTypographySegmentation:
      model === "qwen-image-2.1" ? "qwen-print" : true,
    sourceEraseMask: true,
    page: maskBaselinePage,
    runner,
    signal,
  });
  const bubbleLayoutConstraintBlockIds = new Set(
    page.blocks
      .filter(
        (block) =>
          targetBlockIdSet.has(block.id) &&
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
  return buildMaskPrepassResult(
    processed,
    [...bubbleLayoutConstraintBlockIds],
    restoreLayout,
  );
}

function buildMaskPrepassResult(
  processed: Awaited<ReturnType<typeof runBubbleLayoutPostprocess>>,
  bubbleLayoutConstraintBlockIds: string[],
  restoreLayout: InpaintingBlockLayoutState[],
): {
  bubbleLayoutConstraintBlockIds: string[];
  page: MangaPage;
  restoreLayout?: InpaintingBlockLayoutState[];
  sharedInpaintGroupIdsByBlock?: Record<string, string[]>;
  sourceEraseConstraintsByBlock?: Record<string, InpaintingWindowMask>;
  typographySegmentation?: KoharuTypographySegmentation;
} {
  return {
    bubbleLayoutConstraintBlockIds,
    page: processed.page,
    sourceEraseConstraintsByBlock: processed.sourceEraseConstraintsByBlock,
    ...(restoreLayout.length ? { restoreLayout } : {}),
    ...(processed.sharedInpaintGroupIdsByBlock
      ? {
          sharedInpaintGroupIdsByBlock: processed.sharedInpaintGroupIdsByBlock,
        }
      : {}),
    ...(processed.typographySegmentation
      ? { typographySegmentation: processed.typographySegmentation }
      : {}),
  };
}

function resolvePrepassBlockIds(
  page: MangaPage,
  blockId: string | undefined,
  blockIds: readonly string[] | undefined,
): string[] {
  if (blockId) return [blockId];
  if (blockIds) return [...blockIds];
  return page.blocks.map((block) => block.id);
}
