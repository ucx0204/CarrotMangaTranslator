import type {
  BubbleLayoutPolicy,
  StartInpaintingRequest,
} from "../../shared/inpaintingTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import type { AppSettings } from "../../shared/settingsTypes";
import type { BBox, TranslationBlock } from "../../shared/textTypes";
import { resolveBubbleLayoutPaddingRatio } from "../../shared/bubbleLayoutPadding";
import type { ImageDecodeFallback } from "../regionCrop";
import { isUsableBubbleLayout } from "../../shared/bubbleLayout";
import {
  applyInpaintingLayoutStates,
  captureInpaintingLayoutStates,
  type InpaintingBlockLayoutState,
} from "./inpaintingLayoutState";
import {
  applyBubbleNaturalTextLayout,
  collectBubbleLayoutChanges,
  type BubbleNaturalTextLayoutConfig,
} from "./bubbleLayoutNaturalText";
import {
  collectSharedInpaintGroups,
  parseBubbleLayoutRunnerPatches,
  type BubbleLayoutBlockPatch,
} from "./bubbleLayoutRunnerPatches";

type RenderBboxSpace = NonNullable<TranslationBlock["renderBboxSpace"]>;

export type BubbleLayoutRunnerRequest = {
  /**
   * Mask preparation may fall back and let the final pass retry. A persisted
   * final/layout-only pass must surface detector and image-processing errors.
   */
  failureMode?: "best-effort" | "required";
  imagePath: string;
  page: MangaPage;
  policy: BubbleLayoutPolicy;
  paddingRatio?: number;
  /**
   * Render layouts keep a narrow seam between blocks that share one detected
   * balloon. The transient inpainting prepass sets this to zero so all owners
   * share one uncut safe region and Flux never sees half of a source glyph.
   */
  sharedOwnershipGapPx?: number;
  signal: AbortSignal;
};

export type BubbleLayoutRunnerResult = {
  patches: BubbleLayoutBlockPatch[];
};

/** Model/process boundary. Production adapters and tests can implement this port. */
export interface BubbleLayoutRunner {
  runPage(
    request: BubbleLayoutRunnerRequest,
  ): Promise<BubbleLayoutRunnerResult>;
}

export type BubbleLayoutRunnerFactoryOptions = {
  dataRoot: string;
  decodeFallback?: ImageDecodeFallback;
};

export type BubbleLayoutRunnerFactory = (
  options: BubbleLayoutRunnerFactoryOptions,
) => BubbleLayoutRunner;

export type BubbleLayoutPostprocessConfig = {
  policy: BubbleLayoutPolicy;
  paddingRatio?: number;
  sharedOwnershipGapPx?: number;
  /**
   * Only the explicit "detect again" command may replace user-authored
   * geometry. Translation/inpainting follow-up jobs keep it intact.
   */
  overwriteManual: boolean;
  /** Apply hard line breaks only after the final balloon geometry is known. */
  naturalTextLayout?: BubbleNaturalTextLayoutConfig;
};

export type BubbleLayoutPostprocessResult = {
  page: MangaPage;
  beforeLayout?: InpaintingBlockLayoutState[];
  afterLayout?: InpaintingBlockLayoutState[];
  sharedInpaintGroupIdsByBlock?: Record<string, string[]>;
};

export function resolveBubbleLayoutPostprocessConfig(
  request: StartInpaintingRequest,
  settings: AppSettings,
): BubbleLayoutPostprocessConfig | null {
  const requested = request.postprocess?.bubbleLayout;
  const enabled =
    requested?.enabled ??
    settings.inpainting?.bubbleLayoutAfterInpainting ??
    false;
  return enabled
    ? {
        policy: requested?.policy ?? "balanced",
        paddingRatio: resolveSettingsBubbleLayoutPaddingRatio(settings),
        overwriteManual: false,
        ...(requested?.naturalTextLayout
          ? {
              naturalTextLayout: {
                locale: settings.translation?.targetLanguage,
              },
            }
          : {}),
      }
    : null;
}

export async function runBubbleLayoutPostprocess({
  blockId,
  blockIds,
  config,
  failureMode = "required",
  page,
  runner,
  signal,
}: {
  blockId?: string;
  /** Limit persisted layout/text changes to blocks erased in this run. */
  blockIds?: readonly string[];
  config: BubbleLayoutPostprocessConfig;
  failureMode?: "best-effort" | "required";
  page: MangaPage;
  runner: BubbleLayoutRunner;
  signal: AbortSignal;
}): Promise<BubbleLayoutPostprocessResult> {
  throwIfAborted(signal);
  // The manual layout-only action must also work before inpainting. Use the
  // cleaned artifact when it exists because it produces a better safe mask,
  // otherwise derive the same render-only layout from the original page.
  const imagePath = page.inpaintedImagePath ?? page.imagePath;

  // Never expose the page instance that will be committed to an adapter.
  // Returned data is applied through the render-only patch allowlist below.
  const baselinePage = clonePageWithBlocks(page);
  const runnerPage = clonePageWithBlocks(baselinePage);
  let result: BubbleLayoutRunnerResult;
  try {
    result = await runner.runPage({
      failureMode,
      imagePath,
      page: runnerPage,
      policy: config.policy,
      paddingRatio: resolveBubbleLayoutPaddingRatio(config.paddingRatio),
      sharedOwnershipGapPx: config.sharedOwnershipGapPx,
      signal,
    });
  } catch (error) {
    throwIfAborted(signal);
    if (failureMode !== "best-effort") throw error;
    return { page: baselinePage };
  }
  throwIfAborted(signal);
  const patches = parseBubbleLayoutRunnerPatches(
    result,
    baselinePage,
    config.overwriteManual,
    blockId,
    blockIds,
  );
  const geometryPage = applyRunnerPatchesToPage(baselinePage, patches);
  const finalPage = applyBubbleNaturalTextLayout(
    geometryPage,
    config.naturalTextLayout,
    blockId,
    blockIds,
  );
  const { beforeLayout, afterLayout } = collectBubbleLayoutChanges(
    baselinePage,
    finalPage,
    patches.map((patch) => patch.blockId),
  );
  const sharedInpaintGroupIdsByBlock = collectSharedInpaintGroups(patches);
  if (afterLayout.length === 0) {
    return {
      page: baselinePage,
      ...(Object.keys(sharedInpaintGroupIdsByBlock).length
        ? { sharedInpaintGroupIdsByBlock }
        : {}),
    };
  }

  return {
    page: applyInpaintingLayoutStates(baselinePage, afterLayout),
    beforeLayout,
    afterLayout,
    ...(Object.keys(sharedInpaintGroupIdsByBlock).length
      ? { sharedInpaintGroupIdsByBlock }
      : {}),
  };
}

function clonePageWithBlocks(page: MangaPage): MangaPage {
  return {
    ...page,
    blocks: page.blocks.map((block) => structuredClone(block)),
  };
}

function applyRunnerPatchesToPage(
  page: MangaPage,
  patches: readonly BubbleLayoutBlockPatch[],
): MangaPage {
  const states = patches.map((patch) => {
    const before = captureInpaintingLayoutStates(page, [patch.blockId])[0];
    if (!before) {
      throw new Error("말풍선 배치를 적용할 텍스트 블록을 찾지 못했습니다.");
    }
    return applyRunnerPatchToState(before, patch, page);
  });
  return applyInpaintingLayoutStates(page, states);
}

function applyRunnerPatchToState(
  before: InpaintingBlockLayoutState,
  patch: BubbleLayoutBlockPatch,
  page: MangaPage,
): InpaintingBlockLayoutState {
  const after = applyRunnerRenderPatch(structuredClone(before), patch, page);
  return applyRunnerBubblePatch(before, after, patch);
}

function applyRunnerRenderPatch(
  after: InpaintingBlockLayoutState,
  patch: BubbleLayoutBlockPatch,
  page: MangaPage,
): InpaintingBlockLayoutState {
  if (hasOwn(patch, "renderBbox")) {
    after.renderBbox = patch.renderBbox
      ? structuredClone(patch.renderBbox)
      : null;
    if (after.renderBbox === null) {
      after.renderBboxSpace = null;
    } else if (!hasOwn(patch, "renderBboxSpace")) {
      after.renderBboxSpace = after.renderBboxSpace ?? "normalized_1000";
    }
  }
  if (hasOwn(patch, "renderBboxSpace")) {
    after.renderBboxSpace = parseRenderBboxSpace(patch.renderBboxSpace);
  }
  if (after.renderBbox === null && after.renderBboxSpace !== null) {
    throw new Error(
      "말풍선 배치 결과에 렌더링 영역 없이 좌표계만 지정되었습니다.",
    );
  }
  assertRunnerRenderBbox(after, page);
  return after;
}

function parseRenderBboxSpace(
  value: BubbleLayoutBlockPatch["renderBboxSpace"],
): RenderBboxSpace | null {
  if (value === null) {
    return null;
  }
  if (value === "normalized_1000" || value === "pixels") {
    return value;
  }
  throw new Error("말풍선 배치 결과의 좌표계가 올바르지 않습니다.");
}

function applyRunnerBubblePatch(
  before: InpaintingBlockLayoutState,
  after: InpaintingBlockLayoutState,
  patch: BubbleLayoutBlockPatch,
): InpaintingBlockLayoutState {
  if (!hasOwn(patch, "bubbleLayout")) {
    return after;
  }
  if (patch.bubbleLayout === null && before.bubbleLayout === null) {
    throw new Error(
      "기존 말풍선 배치가 없는 블록에는 초기화 결과를 적용할 수 없습니다.",
    );
  }
  if (
    patch.bubbleLayout !== null &&
    !isUsableBubbleLayout(patch.bubbleLayout)
  ) {
    throw new Error("말풍선 배치 결과의 영역 정보가 올바르지 않습니다.");
  }
  after.bubbleLayout =
    patch.bubbleLayout === null ? null : structuredClone(patch.bubbleLayout);
  return after;
}

function assertRunnerRenderBbox(
  state: InpaintingBlockLayoutState,
  page: Pick<MangaPage, "width" | "height">,
): void {
  const bbox = state.renderBbox;
  if (!bbox) {
    return;
  }
  const limitX = state.renderBboxSpace === "pixels" ? page.width : 1000;
  const limitY = state.renderBboxSpace === "pixels" ? page.height : 1000;
  if (!isFinitePositiveBbox(bbox) || !isBboxInside(bbox, limitX, limitY)) {
    throw new Error("말풍선 배치 결과의 렌더링 영역이 올바르지 않습니다.");
  }
}

function isFinitePositiveBbox(bbox: BBox): boolean {
  return (
    [bbox.x, bbox.y, bbox.w, bbox.h].every(Number.isFinite) &&
    bbox.w > 0 &&
    bbox.h > 0
  );
}

function isBboxInside(bbox: BBox, limitX: number, limitY: number): boolean {
  return (
    bbox.x >= 0 &&
    bbox.y >= 0 &&
    bbox.x + bbox.w <= limitX &&
    bbox.y + bbox.h <= limitY
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function resolveSettingsBubbleLayoutPaddingRatio(
  settings: AppSettings,
): number {
  return resolveBubbleLayoutPaddingRatio(
    settings.inpainting?.bubbleLayoutPaddingRatio,
  );
}
