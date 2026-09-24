import { join } from "node:path";
import { hashStableValue } from "../../shared/blockFingerprint";
import type { PageDeletionRecord } from "../application/mcpPageDeletionState";
import type { LibraryTransaction } from "../libraryStore/libraryTransaction";
import { stageWorkFile } from "../libraryStore/libraryTransactionFiles";
import { stagePageDeletionUnlocked } from "../libraryStore/libraryPageDeletion";
import { chapterDeletionDirectory } from "./mcpChapterDeletionRepository";
import { pageDeletionRetirements } from "./mcpPageDeletionEvidence";
import {
  captureStagedDeletionTree,
  readRecoveryFileBytes,
  verifyChapterDeletionFiles,
} from "./mcpChapterDeletionFiles";
import type { McpRetentionStorage } from "./mcpRetentionStorage";

/** Only missing page-owned directories are published. The surviving chapter is never replaced. */
export async function stagePageDeletionRecovery(
  tx: LibraryTransaction,
  storage: McpRetentionStorage,
  record: PageDeletionRecord,
  direction: "undo" | "redo",
  guard: () => void,
) {
  const root = chapterDeletionDirectory(record.input);
  const retired = pageDeletionRetirements(
    record.input,
    record.before.chapter,
    record.tree,
  );
  if (direction === "redo")
    return stagePageDeletionUnlocked(tx, {
      before: record.before,
      after: record.after,
      files: retired.files.map((path) => join(root, path)),
      directories: retired.directories.map((path) => join(root, path)),
    });
  for (const directory of retired.directories)
    await restoreDirectory(tx, storage, record, directory, guard);
  for (const [index, file] of record.tree.files.entries()) {
    guard();
    if (
      retired.directories.some((directory) =>
        file.path.startsWith(directory + "/"),
      )
    )
      continue;
    const current = record.afterTree.files.find(
      (after) => after.path === file.path,
    );
    if (current?.sha256 === file.sha256 && current.bytes === file.bytes)
      continue;
    await tx.stageBytesReplacement(
      join(root, file.path),
      await readRecoveryFileBytes(storage, record, index, guard),
    );
  }
  await stageWorkFile(tx, record.before.work);
  guard();
}

async function restoreDirectory(
  tx: LibraryTransaction,
  storage: McpRetentionStorage,
  record: PageDeletionRecord,
  path: string,
  guard: () => void,
) {
  guard();
  const prefix = path + "/";
  const indexes = record.tree.files.flatMap((file, index) =>
    file.path.startsWith(prefix) ? [index] : [],
  );
  const subset = {
    id: record.id,
    tree: {
      directories: record.tree.directories
        .filter((directory) => directory.startsWith(prefix))
        .map((directory) => directory.slice(prefix.length)),
      files: indexes.map((index) => ({
        ...record.tree.files[index],
        path: record.tree.files[index].path.slice(prefix.length),
      })),
    },
    parts: indexes.map((index) => record.parts[index]),
  };
  const staged = await tx.createPublishedDirectory(
    join(chapterDeletionDirectory(record.input), path),
  );
  await verifyChapterDeletionFiles(
    storage,
    subset,
    guard,
    staged.stagingDirectory,
    undefined,
    null,
  );
  const verify = async () => {
    if (
      hashStableValue(await captureStagedDeletionTree(staged, guard, null)) !==
      hashStableValue(subset.tree)
    )
      throw new Error(
        "Staged page artifacts differ from their verified originals.",
      );
    guard();
  };
  await verify();
  tx.beforePublish(verify);
}
