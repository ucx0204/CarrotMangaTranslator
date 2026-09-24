import { join } from "node:path";
import { hashStableValue } from "../../shared/blockFingerprint";
import type { ChapterMoveRecord } from "../application/mcpChapterMoveState";
import type { LibraryTransaction } from "../libraryStore/libraryTransaction";
import { writeDurableFile } from "../libraryStore/libraryTransactionStorage";
import { stageWorkFile } from "../libraryStore/libraryTransactionFiles";
import { stageChapterDeletionUnlocked } from "../libraryStore/libraryChapterDeletion";
import { chapterDeletionDirectory } from "./mcpChapterDeletionRepository";
import {
  captureStagedDeletionTree,
  validateChapterDeletionTree,
  verifyChapterDeletionFiles,
} from "./mcpChapterDeletionFiles";
import {
  chapterMoveReplacements,
  chapterMoveTree,
} from "./mcpChapterMoveContent";
import type { McpRetentionStorage } from "./mcpRetentionStorage";

export function validateChapterMoveContent(record: ChapterMoveRecord) {
  validateChapterDeletionTree(record.tree);
  validateChapterDeletionTree(record.afterTree);
  const expected = chapterMoveTree(
    record.tree,
    chapterMoveReplacements(record.afterChapter, record.afterMemory),
  );
  if (hashStableValue(expected) !== hashStableValue(record.afterTree))
    throw new Error(
      "Moved chapter metadata differs from its recorded byte inventory.",
    );
}

/** Destination publication, original retirement and both work orders share one existing transaction. */
export async function stageChapterMove(
  transaction: LibraryTransaction,
  storage: McpRetentionStorage,
  record: ChapterMoveRecord,
  moved: boolean,
  guard: () => void,
  stagedArchive?: string,
) {
  validateChapterMoveContent(record);
  const intent = record.input.intent;
  const targetWork = moved ? intent.destinationWorkId : intent.workId;
  const directory = await transaction.createPublishedDirectory(
    chapterDeletionDirectory({
      workId: targetWork,
      chapterId: intent.chapterId,
    }),
  );
  await verifyChapterDeletionFiles(
    storage,
    record,
    guard,
    directory.stagingDirectory,
    stagedArchive,
  );
  if (moved)
    for (const [path, bytes] of chapterMoveReplacements(
      record.afterChapter,
      record.afterMemory,
    )) {
      guard();
      await writeDurableFile(join(directory.stagingDirectory, path), bytes);
    }
  const frame = moved ? record.after : record.before;
  await stageChapterDeletionUnlocked(
    transaction,
    frame.works[moved ? 0 : 1],
    intent.chapterId,
  );
  await stageWorkFile(transaction, frame.works[moved ? 1 : 0]);
  const expected = moved ? record.afterTree : record.tree;
  const verify = async () => {
    guard();
    const tree = await captureStagedDeletionTree(directory, guard);
    if (hashStableValue(tree) !== hashStableValue(expected))
      throw new Error(
        "Staged moved/restored chapter differs from its exact recorded inventory.",
      );
    guard();
  };
  await verify();
  transaction.beforePublish(verify);
}
