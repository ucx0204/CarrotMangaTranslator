import { dirname, join } from "node:path";
import { hashStableValue } from "../../shared/blockFingerprint";
import { ChapterStoryMemorySchema } from "../../shared/ipcWorkContextSchemas";
import type { ChapterStoryMemory } from "../../shared/workContextTypes";
import type { ChapterFile } from "./libraryFiles";
import { getChapterFilePath, getLibraryRoot } from "./libraryPaths";
import { readJsonFile } from "./storage";
import { readLibraryJsonFile } from "./libraryJsonValidation";
import {
  assertPathWithinRootWithoutSymlinks,
  pathState,
} from "./libraryTransactionStorage";
import {
  reorderIds,
  reorderRecords,
  resolveChapterStatus,
} from "./chapterRecords";
import { resolveReconciledStoryMemory } from "./workContextFiles";
import { stageStoryMemoryFile } from "./libraryTransactionFiles";
import type { LibraryTransaction } from "./libraryTransaction";

export type LibraryPageOrdering = {
  order: string[];
  records: string[];
  status: ChapterFile["status"];
  memory: ChapterStoryMemory | null;
};

/** Capture native metadata, not image bytes. Missing memory has a stable null value. */
export async function readLibraryPageOrdering(
  chapter: ChapterFile,
): Promise<LibraryPageOrdering> {
  const path = join(
    dirname(getChapterFilePath(chapter.workId, chapter.id)),
    "story-memory.json",
  );
  await assertPathWithinRootWithoutSymlinks(getLibraryRoot(), path, {
    allowMissingTarget: true,
  });
  const presence = await pathState(path);
  if (presence !== "missing" && presence !== "file")
    throw new Error("Story memory must be an ordinary file.");
  const memory =
    presence === "missing"
      ? null
      : readLibraryJsonFile(ChapterStoryMemorySchema, await readJsonFile(path));
  if (
    memory &&
    (memory.workId !== chapter.workId || memory.chapterId !== chapter.id)
  )
    throw new Error("Story memory belongs to another chapter.");
  return capture(chapter, memory);
}

/** Original desktop partial-order, status and memory algorithms; no new summarizer. */
export function prepareLibraryPageOrdering(
  chapter: ChapterFile,
  current: LibraryPageOrdering,
  pageIds: string[],
  updatedAt: string,
) {
  const order = reorderIds(chapter.pageOrder, pageIds);
  const pages = reorderRecords(chapter.pages, order);
  const after = {
    ...chapter,
    pageOrder: order,
    pages,
    updatedAt,
    status: resolveChapterStatus(pages),
  };
  const memory = current.memory
    ? resolveReconciledStoryMemory(current.memory, pages, updatedAt)
    : null;
  return { chapter: after, ordering: capture(after, memory) };
}

/** Restore only order/status; existing page payloads and source provenance stay intact. */
export function restoreLibraryPageOrdering(
  chapter: ChapterFile,
  ordering: LibraryPageOrdering,
): ChapterFile {
  const current = new Set(chapter.pages.map((page) => page.id));
  if (
    ordering.records.length !== current.size ||
    new Set(ordering.records).size !== current.size ||
    ordering.records.some((id) => !current.has(id))
  )
    throw new Error(
      "Saved page inventory cannot be restored onto this chapter.",
    );
  return {
    ...chapter,
    pageOrder: [...ordering.order],
    pages: reorderRecords(chapter.pages, ordering.records),
    status: ordering.status,
  };
}

/** Memory and chapter publication join the caller's one native transaction. */
export async function stageLibraryPageOrdering(
  transaction: LibraryTransaction,
  before: LibraryPageOrdering,
  after: LibraryPageOrdering,
) {
  if ((before.memory === null) !== (after.memory === null))
    throw new Error("Page ordering cannot create or delete the memory file.");
  if (
    after.memory &&
    hashStableValue(before.memory) !== hashStableValue(after.memory)
  )
    await stageStoryMemoryFile(transaction, after.memory);
}

function capture(
  chapter: ChapterFile,
  memory: ChapterStoryMemory | null,
): LibraryPageOrdering {
  return {
    order: [...chapter.pageOrder],
    records: chapter.pages.map((page) => page.id),
    status: chapter.status,
    memory,
  };
}
