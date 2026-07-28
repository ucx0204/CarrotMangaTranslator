import type {
  BubbleLayoutPolicy,
  StartInpaintingRequest,
} from "../../shared/inpaintingTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import type { AppSettings } from "../../shared/settingsTypes";
import type { BBox, TranslationBlock } from "../../shared/textTypes";
import type { ImageDecodeFallback } from "../regionCrop";
import {
  isManualBubbleLayout,
  isUsableBubbleLayout,
  type BubbleLayout,
} from "../../shared/bubbleLayout";
import {
  applyInpaintingLayoutStates,
  captureInpaintingLayoutStates,
  inpaintingLayoutStatesEqual,
  type InpaintingBlockLayoutState,
} from "./inpaintingLayoutState";

type RenderBboxSpace = NonNullable<TranslationBlock["renderBboxSpace"]>;

export type BubbleLayoutBlockPatch = {
  blockId: string;
  renderBbox?: BBox | null;
  renderBboxSpace?: RenderBboxSpace | null;
  bubbleLayout?: BubbleLayout | null;
};

export type BubbleLayoutRunnerRequest = {
  imagePath: string;
  page: MangaPage;
  policy: BubbleLayoutPolicy;
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
  /**
   * Only the explicit "detect again" command may replace user-authored
   * geometry. Translation/inpainting follow-up jobs keep it intact.
   */
  overwriteManual: boolean;
};

export type BubbleLayoutPostprocessResult = {
  page: MangaPage;
  beforeLayout?: InpaintingBlockLayoutState[];
  afterLayout?: InpaintingBlockLayoutState[];
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
        overwriteManual: false,
      }
    : null;
}

export async function runBubbleLayoutPostprocess({
  config,
  page,
  runner,
  signal,
}: {
  config: BubbleLayoutPostprocessConfig;
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
  const baselinePage: MangaPage = {
    ...page,
    blocks: page.blocks.map((block) => structuredClone(block)),
  };
  const runnerPage: MangaPage = {
    ...baselinePage,
    blocks: baselinePage.blocks.map((block) => structuredClone(block)),
  };
  const result = await runner.runPage({
    imagePath,
    page: runnerPage,
    policy: config.policy,
    signal,
  });
  throwIfAborted(signal);
  const patches = parseRunnerPatches(
    result,
    baselinePage,
    config.overwriteManual,
  );
  if (patches.length === 0) {
    return { page: baselinePage };
  }

  const beforeLayout: InpaintingBlockLayoutState[] = [];
  const afterLayout: InpaintingBlockLayoutState[] = [];
  for (const patch of patches) {
    const before = captureInpaintingLayoutStates(baselinePage, [
      patch.blockId,
    ])[0];
    if (!before) {
      throw new Error("말풍선 배치를 적용할 텍스트 블록을 찾지 못했습니다.");
    }
    const after = applyRunnerPatchToState(before, patch, baselinePage);
    if (inpaintingLayoutStatesEqual([before], [after])) {
      continue;
    }
    beforeLayout.push(before);
    afterLayout.push(after);
  }
  if (afterLayout.length === 0) {
    return { page: baselinePage };
  }

  return {
    page: applyInpaintingLayoutStates(baselinePage, afterLayout),
    beforeLayout,
    afterLayout,
  };
}

function parseRunnerPatches(
  result: BubbleLayoutRunnerResult,
  page: MangaPage,
  overwriteManual: boolean,
): BubbleLayoutBlockPatch[] {
  if (!result || !Array.isArray(result.patches)) {
    throw new Error("말풍선 배치 결과 형식이 올바르지 않습니다.");
  }
  if (result.patches.length > page.blocks.length) {
    throw new Error("말풍선 배치 결과에 너무 많은 블록이 포함되었습니다.");
  }
  const blocksById = new Map(page.blocks.map((block) => [block.id, block]));
  const seen = new Set<string>();
  const patches: BubbleLayoutBlockPatch[] = [];
  for (const rawPatch of result.patches) {
    const block = resolveRunnerPatchBlock(rawPatch, blocksById);
    if (seen.has(rawPatch.blockId)) {
      throw new Error("말풍선 배치 결과에 같은 블록이 중복되었습니다.");
    }
    seen.add(rawPatch.blockId);
    if (!overwriteManual && isManualBubbleLayout(block.bubbleLayout)) {
      continue;
    }
    patches.push(copyRunnerRenderPatch(rawPatch));
  }
  return patches;
}

function resolveRunnerPatchBlock(
  rawPatch: BubbleLayoutBlockPatch,
  blocksById: ReadonlyMap<string, TranslationBlock>,
): TranslationBlock {
  if (
    !rawPatch ||
    typeof rawPatch !== "object" ||
    typeof rawPatch.blockId !== "string"
  ) {
    throw new Error("말풍선 배치 결과에 알 수 없는 블록이 포함되었습니다.");
  }
  const block = blocksById.get(rawPatch.blockId);
  if (!block) {
    throw new Error("말풍선 배치 결과에 알 수 없는 블록이 포함되었습니다.");
  }
  return block;
}

function copyRunnerRenderPatch(
  rawPatch: BubbleLayoutBlockPatch,
): BubbleLayoutBlockPatch {
  // Construct a fresh object instead of spreading adapter output. In
  // particular, an accidental/malicious `bbox` field can never cross this
  // boundary.
  const patch: BubbleLayoutBlockPatch = { blockId: rawPatch.blockId };
  if (hasOwn(rawPatch, "renderBbox")) {
    patch.renderBbox = rawPatch.renderBbox;
  }
  if (hasOwn(rawPatch, "renderBboxSpace")) {
    patch.renderBboxSpace = rawPatch.renderBboxSpace;
  }
  if (hasOwn(rawPatch, "bubbleLayout")) {
    patch.bubbleLayout = rawPatch.bubbleLayout;
  }
  return patch;
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
