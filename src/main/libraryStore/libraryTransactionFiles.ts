import {
  ChapterStoryMemorySchema,
  LibraryChapterFileSchema,
  LibraryWorkFileSchema,
  StoredLibraryIndexFileSchema,
  WorkStyleGuideSchema,
} from "../../shared/ipcSchemas";
import type {
  ChapterStoryMemory,
  WorkStyleGuide,
} from "../../shared/workContextTypes";
import { join } from "node:path";
import {
  getChapterFilePath,
  getLibraryIndexPath,
  getWorkFilePath,
  getWorksRoot,
} from "./libraryPaths";
import {
  validateChapterFilePaths,
  validateIndexFile,
  validateWorkFile,
  type ChapterFile,
  type StoredIndexFile,
  type WorkFile,
} from "./libraryFiles";
import { readLibraryJsonFile } from "./libraryJsonValidation";
import type { LibraryTransaction } from "./libraryTransaction";
import { assertSafeStoreId } from "./libraryStoreIds";

export async function stageIndexFile(
  transaction: LibraryTransaction,
  index: StoredIndexFile,
): Promise<void> {
  const checked = validateIndexFile(
    readLibraryJsonFile(StoredLibraryIndexFileSchema, index),
  );
  await transaction.stageJsonReplacement(getLibraryIndexPath(), checked);
}

export async function stageWorkFile(
  transaction: LibraryTransaction,
  work: WorkFile,
): Promise<void> {
  const checked = validateWorkFile(
    work.id,
    readLibraryJsonFile(LibraryWorkFileSchema, work),
  );
  await transaction.stageJsonReplacement(getWorkFilePath(work.id), checked);
}

export async function stageChapterFile(
  transaction: LibraryTransaction,
  chapter: ChapterFile,
): Promise<void> {
  const checked = validateChapterFilePaths(
    chapter.workId,
    chapter.id,
    readLibraryJsonFile(LibraryChapterFileSchema, chapter),
  );
  await transaction.stageJsonReplacement(
    getChapterFilePath(chapter.workId, chapter.id),
    checked,
  );
}

export async function stageStyleGuideFile(
  transaction: LibraryTransaction,
  guide: WorkStyleGuide,
): Promise<void> {
  const checked = readLibraryJsonFile(WorkStyleGuideSchema, guide);
  assertSafeStoreId(checked.workId, "작품 ID가 올바르지 않습니다.");
  await transaction.stageJsonReplacement(
    join(getWorksRoot(), checked.workId, "style-guide.json"),
    checked,
  );
}

export async function stageStoryMemoryFile(
  transaction: LibraryTransaction,
  memory: ChapterStoryMemory,
): Promise<void> {
  const checked = readLibraryJsonFile(ChapterStoryMemorySchema, memory);
  assertSafeStoreId(checked.workId, "작품 ID가 올바르지 않습니다.");
  assertSafeStoreId(checked.chapterId, "화 ID가 올바르지 않습니다.");
  await transaction.stageJsonReplacement(
    join(
      getWorksRoot(),
      checked.workId,
      "chapters",
      checked.chapterId,
      "story-memory.json",
    ),
    checked,
  );
}
