import type { TranslationCompletionReceipt } from "../shared/libraryTypes";
import type { TranslationBlock } from "../shared/textTypes";

export function assertUniqueTranslationBlockIds(
  blocks: readonly Pick<TranslationBlock, "id">[],
  message: string,
): void {
  const seen = new Set<string>();

  for (const block of blocks) {
    if (seen.has(block.id)) {
      throw new Error(message);
    }
    seen.add(block.id);
  }
}

export function remapTranslationCompletionReferences(
  current: TranslationCompletionReceipt | undefined,
  blockIdMap: ReadonlyMap<string, string>,
): TranslationCompletionReceipt | undefined {
  return rewriteTranslationCompletionReferences(current, (sourceId) =>
    blockIdMap.get(sourceId),
  );
}

export function normalizeTranslationCompletionReferences(
  current: TranslationCompletionReceipt | undefined,
  blocks: readonly Pick<TranslationBlock, "id">[],
): TranslationCompletionReceipt | undefined {
  const validIds = new Set(blocks.map((block) => block.id));
  return rewriteTranslationCompletionReferences(current, (sourceId) =>
    validIds.has(sourceId) ? sourceId : undefined,
  );
}

function rewriteTranslationCompletionReferences(
  current: TranslationCompletionReceipt | undefined,
  resolveId: (sourceId: string) => string | undefined,
): TranslationCompletionReceipt | undefined {
  if (!current) {
    return undefined;
  }

  const erased = current.erasedBlockIds;
  if (!erased || erased.length === 0) {
    return {
      workflow: current.workflow,
      status: current.status,
    };
  }

  const rewritten: string[] = [];
  for (const sourceId of erased) {
    const destinationId = resolveId(sourceId);
    if (!destinationId) {
      return invalidateUnknownReferences(current);
    }
    rewritten.push(destinationId);
  }

  if (new Set(rewritten).size !== rewritten.length) {
    return invalidateUnknownReferences(current);
  }

  return {
    workflow: current.workflow,
    status: current.status,
    erasedBlockIds: rewritten,
  };
}

function invalidateUnknownReferences(
  current: TranslationCompletionReceipt,
): TranslationCompletionReceipt {
  if (current.status === "completed") {
    return {
      workflow: current.workflow,
      status: "completed",
    };
  }

  return {
    workflow: current.workflow,
    status: "pending",
  };
}
