import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import { clearAutomaticFontMatchForManualStylePatch } from "./automaticFontMatchProvenance";
import {
  normalizeRenderDirection,
  normalizeRotationDeg,
} from "./blockFormatGeometry";
import {
  GATHER_TEXT_DIRECT_FORMAT_FIELDS,
  type GatherTextDirectFormatPatch,
} from "./gatherTextDirectFormatModel";

export type BlockRef = {
  pageId: string;
  blockId: string;
};

export type GatherDirectFormatPatch = GatherTextDirectFormatPatch;

export type GatherDirectFormatRequest = {
  targets: BlockRef[];
  patch: GatherDirectFormatPatch;
};

export type GatherFormatApplyResult = {
  chapter: ChapterSnapshot;
  dirtyPageIds: string[];
};

export function blockRefKey(ref: BlockRef): string {
  return ref.pageId + "\u0000" + ref.blockId;
}

export function sameBlockRef(
  left: BlockRef | null | undefined,
  right: BlockRef | null | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.pageId === right.pageId && left.blockId === right.blockId;
}

export function findBlockByRef(
  chapter: ChapterSnapshot | null,
  ref: BlockRef | null,
): TranslationBlock | null {
  if (!chapter || !ref) return null;
  return (
    chapter.pages
      .find((page) => page.id === ref.pageId)
      ?.blocks.find((block) => block.id === ref.blockId) ?? null
  );
}

/** Apply only the explicitly edited format fields to every selected block. */
export function applyGatherDirectFormat(
  chapter: ChapterSnapshot,
  request: GatherDirectFormatRequest,
  stamp = new Date().toISOString(),
): GatherFormatApplyResult {
  const targetKeys = new Set(request.targets.map(blockRefKey));
  const patch = pickDirectFormatPatch(request.patch);
  if (targetKeys.size === 0 || Object.keys(patch).length === 0) {
    return { chapter, dirtyPageIds: [] };
  }

  const dirtyPageIds: string[] = [];
  const pages = chapter.pages.map((page) => {
    let changed = false;
    const blocks = page.blocks.map((block) => {
      if (
        !targetKeys.has(
          blockRefKey({
            pageId: page.id,
            blockId: block.id,
          }),
        )
      ) {
        return block;
      }
      const next = applyFormatPatch(block, patch);
      if (next === block) return block;
      changed = true;
      return next;
    });
    if (!changed) return page;
    dirtyPageIds.push(page.id);
    return { ...page, blocks, updatedAt: stamp };
  });

  return dirtyPageIds.length > 0
    ? { chapter: { ...chapter, pages }, dirtyPageIds }
    : { chapter, dirtyPageIds };
}

function pickDirectFormatPatch(
  patch: GatherDirectFormatPatch,
): GatherDirectFormatPatch {
  const picked: Record<string, unknown> = {};
  for (const field of GATHER_TEXT_DIRECT_FORMAT_FIELDS) {
    if (Object.hasOwn(patch, field)) {
      picked[field] = patch[field];
    }
  }
  return picked as GatherDirectFormatPatch;
}

function applyFormatPatch(
  block: TranslationBlock,
  patch: Partial<TranslationBlock>,
): TranslationBlock {
  const provenanceSafePatch = clearAutomaticFontMatchForManualStylePatch(
    block,
    patch,
  );
  const normalizedPatch: Partial<TranslationBlock> = {
    ...provenanceSafePatch,
    ...(Object.hasOwn(provenanceSafePatch, "renderDirection")
      ? {
          renderDirection: normalizeRenderDirection(
            provenanceSafePatch.renderDirection,
            block.renderDirection,
          ),
        }
      : {}),
    ...(Object.hasOwn(provenanceSafePatch, "rotationDeg")
      ? { rotationDeg: normalizeRotationDeg(provenanceSafePatch.rotationDeg) }
      : {}),
  };
  if (
    Object.entries(normalizedPatch).every(([key, value]) =>
      Object.is(block[key as keyof TranslationBlock], value),
    )
  ) {
    return block;
  }
  return { ...block, ...normalizedPatch };
}
