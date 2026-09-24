import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  ContextMigrationDeltaSchema,
  contextBlockReferences,
  restoreContextBlockReferences,
  type ContextMigrationDelta,
} from "../../shared/mcpContextMigrationState";
import { readWorkFile, readChapterFile } from "./libraryFiles";
import {
  getLibraryRoot,
  getWorksRoot,
  getWorkFilePath,
  getChapterFilePath,
} from "./libraryPaths";
import {
  assertPathWithinRootWithoutSymlinks,
  pathState,
  sha256File,
} from "./libraryTransactionStorage";
import {
  stageWorkFile,
  stageChapterFile,
  stageStyleGuideFile,
  stageStoryMemoryFile,
} from "./libraryTransactionFiles";
import { nextChapterUpdatedAt } from "./chapterRecords";
import type { LibraryTransaction } from "./libraryTransaction";

function guidePath(workId: string) {
  return join(getWorksRoot(), workId, "style-guide.json");
}
function memoryPath(workId: string, chapterId: string) {
  return join(
    getWorksRoot(),
    workId,
    "chapters",
    chapterId,
    "story-memory.json",
  );
}
async function fileVersion(path: string, maxBytes?: number) {
  await assertPathWithinRootWithoutSymlinks(getLibraryRoot(), path, {
    allowMissingTarget: true,
  });
  const state = await pathState(path);
  if (state === "missing") return null;
  if (state !== "file")
    throw new Error("Context metadata must be an ordinary file.");
  if (maxBytes === undefined) return sha256File(path);
  const before = await boundedMetadataStat(path, maxBytes);
  const sha256 = await sha256File(path, maxBytes);
  const after = await boundedMetadataStat(path, maxBytes);
  await assertPathWithinRootWithoutSymlinks(getLibraryRoot(), path);
  if (
    after.size !== before.size ||
    after.ino !== before.ino ||
    after.dev !== before.dev ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  )
    throw new Error(
      "Native metadata changed while recording its bounded evidence.",
    );
  return sha256;
}

async function boundedMetadataStat(path: string, maxBytes: number) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Context metadata must be an ordinary file.");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || stat.size > maxBytes)
    throw new Error("Native metadata exceeds the bounded evidence byte limit.");
  return stat;
}

/** Same raw-byte and absent-file authority for native publication evidence. */
export { fileVersion as readNativeMetadataFileVersion };

/** Binds metadata bytes, including absent context files. Image bytes are not consumed. */
export async function captureWorkContextMetadata(
  workId: string,
  guard: () => void,
) {
  guard();
  const path = getWorkFilePath(workId);
  const initial = await fileVersion(path);
  const work = await readWorkFile(workId);
  if (!work || work.chapterOrder.length > 100)
    throw new Error("Context work metadata is unavailable or oversized.");
  const versions = new Map<string, string | null>([[path, initial]]);
  const paths = [
    guidePath(workId),
    ...work.chapterOrder.flatMap((id) => [
      getChapterFilePath(workId, id),
      memoryPath(workId, id),
    ]),
  ];
  for (const file of paths) {
    guard();
    versions.set(file, await fileVersion(file));
  }
  return {
    guidePresent: versions.get(guidePath(workId)) !== null,
    memoryPresence: new Map(
      work.chapterOrder.map((id) => [
        id,
        versions.get(memoryPath(workId, id)) !== null,
      ]),
    ),
    verify: async () => {
      for (const [file, version] of versions) {
        guard();
        if ((await fileVersion(file)) !== version)
          throw new Error("Context metadata changed before publication.");
      }
      guard();
    },
  };
}

/** Stages only catalog/memory files and reference fields through native transactions. */
export async function stageWorkContextMigration(
  transaction: LibraryTransaction,
  workId: string,
  input: ContextMigrationDelta,
  direction: "apply" | "undo" | "redo",
  guideBeforePresent: boolean,
  guard: () => void,
) {
  const delta = ContextMigrationDeltaSchema.parse(input);
  const target = direction === "undo" ? "before" : "after";
  await stageMigrationGuide(
    transaction,
    workId,
    delta.guide,
    direction,
    guideBeforePresent,
  );
  for (const item of delta.memories) {
    guard();
    const memory = item[target];
    if (memory.workId !== workId || memory.chapterId !== item.chapterId)
      throw new Error("Context memory identity changed.");
    if (direction === "undo" && item.beforePresent === false)
      await transaction.retireFile(memoryPath(workId, item.chapterId));
    else await stageStoryMemoryFile(transaction, memory);
  }
  const chapters = [...new Set(delta.pages.map((page) => page.chapterId))];
  for (const id of chapters) {
    guard();
    await stageReferenceChapter(transaction, workId, id, delta, direction);
  }
  if (!delta.guide && !delta.pages.length && !delta.memories.length) return;
  const work = await readWorkFile(workId);
  if (!work) throw new Error("Context work disappeared.");
  await stageWorkFile(transaction, {
    ...work,
    updatedAt: nextChapterUpdatedAt({ updatedAt: work.updatedAt, pages: [] }),
  });
}

async function stageReferenceChapter(
  transaction: LibraryTransaction,
  workId: string,
  chapterId: string,
  delta: ContextMigrationDelta,
  direction: "apply" | "undo" | "redo",
) {
  const chapter = await readChapterFile(workId, chapterId);
  if (!chapter || chapter.workId !== workId)
    throw new Error("Context reference chapter disappeared.");
  const target = direction === "undo" ? "before" : "after";
  const expected = direction === "undo" ? "after" : "before";
  const updatedAt = nextChapterUpdatedAt(chapter);
  for (const change of delta.pages.filter(
    (page) => page.chapterId === chapterId,
  )) {
    const page = chapter.pages.find((item) => item.id === change.pageId);
    if (!page) throw new Error("Context reference page disappeared.");
    const patches = new Map(
      change.blocks.map((patch) => [patch.blockId, patch]),
    );
    page.blocks = page.blocks.map((block) => {
      const patch = patches.get(block.id);
      if (!patch) return block;
      if (
        hashStableValue(contextBlockReferences(block)) !==
        hashStableValue(patch[expected])
      )
        throw new Error("Context block references changed before staging.");
      patches.delete(block.id);
      return restoreContextBlockReferences(block, patch[target]);
    });
    if (patches.size) throw new Error("Context reference block disappeared.");
    page.updatedAt = updatedAt;
  }
  await stageChapterFile(transaction, { ...chapter, updatedAt });
}

async function stageMigrationGuide(
  transaction: LibraryTransaction,
  workId: string,
  change: ContextMigrationDelta["guide"],
  direction: "apply" | "undo" | "redo",
  guideBeforePresent: boolean,
) {
  if (!change) return;
  const guide = direction === "undo" ? change.before : change.after;
  if (guide.workId !== workId)
    throw new Error("Context catalog work identity changed.");
  if (direction === "undo" && !guideBeforePresent)
    await transaction.retireFile(guidePath(workId));
  else await stageStyleGuideFile(transaction, guide);
}
