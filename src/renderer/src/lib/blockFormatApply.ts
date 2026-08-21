import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import {
  normalizeRenderDirection,
  normalizeRotationDeg,
} from "./blockFormatGeometry";

export function applyFormatToChapterPages(
  currentChapter: ChapterSnapshot,
  targetPageIds: ReadonlySet<string>,
  blockIdFilter: ReadonlySet<string> | null,
  patch: Partial<TranslationBlock>,
): ChapterSnapshot {
  const stamp = new Date().toISOString();
  return {
    ...currentChapter,
    pages: currentChapter.pages.map((page) =>
      targetPageIds.has(page.id)
        ? {
            ...page,
            updatedAt: stamp,
            blocks: page.blocks.map((block) =>
              blockIdFilter && !blockIdFilter.has(block.id)
                ? block
                : applyFormatPatchToBlock(block, patch),
            ),
          }
        : page,
    ),
  };
}

function applyFormatPatchToBlock(
  block: TranslationBlock,
  patch: Partial<TranslationBlock>,
): TranslationBlock {
  const next = { ...block, ...patch };
  if (patch.renderDirection !== undefined) {
    next.renderDirection = normalizeRenderDirection(
      patch.renderDirection,
      block.renderDirection,
    );
    delete next.layoutIntent;
    next.layoutIntentSuppressed = true;
  }
  if (patch.rotationDeg !== undefined) {
    next.rotationDeg = normalizeRotationDeg(patch.rotationDeg);
  }
  return next;
}
