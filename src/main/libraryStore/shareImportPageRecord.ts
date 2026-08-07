import type { LibraryPageRecord } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import {
  assertUniqueTranslationBlockIds,
  remapTranslationCompletionReferences,
} from "../translationCompletionReferences";
import { tMain } from "./localization";

export function remapSharedPageBlocks(
  pageId: string,
  sourceBlocks: readonly TranslationBlock[],
): {
  blocks: TranslationBlock[];
  blockIdMap: ReadonlyMap<string, string>;
} {
  assertUniqueTranslationBlockIds(
    sourceBlocks,
    tMain("share.errors.duplicateBlockId"),
  );

  const blockIdMap = new Map<string, string>();
  const blocks = sourceBlocks.map((block, index) => {
    const destinationId = `${pageId}-block-${index + 1}`;
    blockIdMap.set(block.id, destinationId);
    return {
      ...block,
      id: destinationId,
    };
  });

  return {
    blocks,
    blockIdMap,
  };
}

export function buildMaterializedSharedPage({
  packagePage,
  pageId,
  imagePath,
  inpaintedImagePath,
  width,
  height,
  now,
}: {
  packagePage: LibraryPageRecord;
  pageId: string;
  imagePath: string;
  inpaintedImagePath?: string;
  width: number;
  height: number;
  now: string;
}): LibraryPageRecord {
  const { blocks, blockIdMap } = remapSharedPageBlocks(
    pageId,
    packagePage.blocks,
  );
  const translationCompletion = remapTranslationCompletionReferences(
    packagePage.translationCompletion,
    blockIdMap,
  );

  return {
    ...packagePage,
    id: pageId,
    imagePath,
    inpaintedImagePath,
    width,
    height,
    blocks,
    translationCompletion,
    createdAt: now,
    updatedAt: now,
  };
}
