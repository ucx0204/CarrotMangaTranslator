import { isManualBubbleLayout } from "../../shared/bubbleLayout";
import type { BubbleLayout } from "../../shared/bubbleLayout";
import type { MangaPage } from "../../shared/libraryTypes";
import type { BBox, TranslationBlock } from "../../shared/textTypes";

type RenderBboxSpace = NonNullable<TranslationBlock["renderBboxSpace"]>;

export type BubbleLayoutBlockPatch = {
  blockId: string;
  renderBbox?: BBox | null;
  renderBboxSpace?: RenderBboxSpace | null;
  bubbleLayout?: BubbleLayout | null;
  /** Job-local only; never applied to or persisted with a TranslationBlock. */
  sharedInpaintGroupIds?: string[];
};

export function parseBubbleLayoutRunnerPatches(
  result: { patches: BubbleLayoutBlockPatch[] },
  page: MangaPage,
  overwriteManual: boolean,
  blockId?: string,
  blockIds?: readonly string[],
): BubbleLayoutBlockPatch[] {
  assertRunnerPatchCollection(result, page.blocks.length);
  const blocksById = new Map(page.blocks.map((block) => [block.id, block]));
  const allowedBlockIds = blockIds ? new Set(blockIds) : null;
  const seen = new Set<string>();
  const patches: BubbleLayoutBlockPatch[] = [];
  for (const rawPatch of result.patches) {
    const block = resolveRunnerPatchBlock(rawPatch, blocksById);
    assertUniqueRunnerPatch(rawPatch.blockId, seen);
    const patch = selectPersistedPatch(
      rawPatch,
      block,
      overwriteManual,
      blockId,
      allowedBlockIds,
    );
    if (patch) patches.push(patch);
  }
  return patches;
}

export function collectSharedInpaintGroups(
  patches: readonly BubbleLayoutBlockPatch[],
): Record<string, string[]> {
  return Object.fromEntries(
    patches.flatMap((patch) =>
      patch.sharedInpaintGroupIds?.length
        ? [[patch.blockId, [...patch.sharedInpaintGroupIds]]]
        : [],
    ),
  );
}

function assertRunnerPatchCollection(
  result: { patches: BubbleLayoutBlockPatch[] },
  blockCount: number,
): void {
  if (!result || !Array.isArray(result.patches)) {
    throw new Error("말풍선 배치 결과 형식이 올바르지 않습니다.");
  }
  if (result.patches.length > blockCount) {
    throw new Error("말풍선 배치 결과에 너무 많은 블록이 포함되었습니다.");
  }
}

function assertUniqueRunnerPatch(blockId: string, seen: Set<string>): void {
  if (seen.has(blockId)) {
    throw new Error("말풍선 배치 결과에 같은 블록이 중복되었습니다.");
  }
  seen.add(blockId);
}

function selectPersistedPatch(
  rawPatch: BubbleLayoutBlockPatch,
  block: TranslationBlock,
  overwriteManual: boolean,
  blockId: string | undefined,
  allowedBlockIds: ReadonlySet<string> | null,
): BubbleLayoutBlockPatch | null {
  if (blockId && rawPatch.blockId !== blockId) return null;
  if (allowedBlockIds && !allowedBlockIds.has(rawPatch.blockId)) return null;
  if (overwriteManual || !isManualBubbleLayout(block.bubbleLayout)) {
    return copyRunnerRenderPatch(rawPatch);
  }
  const metadataPatch = copyRunnerJobMetadataPatch(rawPatch);
  return metadataPatch.sharedInpaintGroupIds?.length ? metadataPatch : null;
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

function copyRunnerJobMetadataPatch(
  rawPatch: BubbleLayoutBlockPatch,
): BubbleLayoutBlockPatch {
  const patch: BubbleLayoutBlockPatch = { blockId: rawPatch.blockId };
  if (hasOwn(rawPatch, "sharedInpaintGroupIds")) {
    patch.sharedInpaintGroupIds = parseSharedInpaintGroupIds(
      rawPatch.sharedInpaintGroupIds,
    );
  }
  return patch;
}

function copyRunnerRenderPatch(
  rawPatch: BubbleLayoutBlockPatch,
): BubbleLayoutBlockPatch {
  const patch: BubbleLayoutBlockPatch = { blockId: rawPatch.blockId };
  if (hasOwn(rawPatch, "renderBbox")) patch.renderBbox = rawPatch.renderBbox;
  if (hasOwn(rawPatch, "renderBboxSpace")) {
    patch.renderBboxSpace = rawPatch.renderBboxSpace;
  }
  if (hasOwn(rawPatch, "bubbleLayout")) {
    patch.bubbleLayout = rawPatch.bubbleLayout;
  }
  if (hasOwn(rawPatch, "sharedInpaintGroupIds")) {
    patch.sharedInpaintGroupIds = parseSharedInpaintGroupIds(
      rawPatch.sharedInpaintGroupIds,
    );
  }
  return patch;
}

function parseSharedInpaintGroupIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error("말풍선 공유 인페인팅 그룹 형식이 올바르지 않습니다.");
  }
  const ids = value.map((item) => String(item));
  if (ids.some((id) => !/^shared-[1-9]\d{0,5}$/.test(id))) {
    throw new Error("말풍선 공유 인페인팅 그룹 형식이 올바르지 않습니다.");
  }
  return [...new Set(ids)];
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
