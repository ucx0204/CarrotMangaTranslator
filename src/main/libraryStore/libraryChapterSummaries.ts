import { stat } from "node:fs/promises";
import { z } from "zod";
import { LibraryChapterFileSchema } from "../../shared/ipcSchemas";
import { MAX_PAGES_PER_REQUEST } from "../../shared/ipcSchemaPrimitives";
import type { LibraryChapterSummary } from "../../shared/libraryTypes";
import { assertUniqueIds, readLibraryJsonFile } from "./libraryJsonValidation";
import { getChapterFilePath } from "./libraryPaths";
import { readJsonFile } from "./storage";
import { PageWorkflowReceiptSchema } from "../../shared/pageWorkflowReceipt";
import { resolveChapterStatus } from "./chapterRecords";

const ChapterSummaryPageStateSchema = z.object({
  blocks: z.array(z.unknown()).optional(),
  pageWorkflow: PageWorkflowReceiptSchema.optional(),
  analysisStatus: z.enum(["idle", "running", "completed", "failed"]),
  translationCompletion: z
    .object({
      status: z.enum(["pending", "completed", "failed"]),
      workflow: z.enum(["erase-original", "bubble-layout"]).optional(),
    })
    .optional(),
});

const LibraryChapterSummarySourceSchema = LibraryChapterFileSchema.pick({
  id: true,
  workId: true,
  title: true,
  sourceKind: true,
  importSource: true,
  status: true,
  pageOrder: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  pages: z.array(z.unknown()).max(MAX_PAGES_PER_REQUEST),
});

async function readChapterSummarySource(
  workId: string,
  chapterId: string,
): Promise<LibraryChapterSummary | null> {
  const payload = await readJsonFile<unknown | null>(
    getChapterFilePath(workId, chapterId),
    null,
  );
  if (!payload) {
    return null;
  }
  const chapter = readLibraryJsonFile(
    LibraryChapterSummarySourceSchema,
    payload,
  );
  assertChapterSummaryIdentity(chapter.id, chapter.workId, chapterId, workId);
  assertUniqueIds(chapter.pageOrder, "화 파일에 중복된 페이지 ID가 있습니다.");
  return {
    id: chapter.id,
    workId: chapter.workId,
    title: chapter.title,
    status: resolveStoredChapterSummaryStatus(chapter.pages, chapter.status),
    createdAt: chapter.createdAt,
    updatedAt: chapter.updatedAt,
    pageCount: chapter.pages.length,
  };
}

function resolveStoredChapterSummaryStatus(
  pages: unknown[],
  storedStatus: LibraryChapterSummary["status"],
): LibraryChapterSummary["status"] {
  const parsed = z.array(ChapterSummaryPageStateSchema).safeParse(pages);
  return parsed.success ? resolveChapterStatus(parsed.data) : storedStatus;
}

function assertChapterSummaryIdentity(
  storedChapterId: string,
  storedWorkId: string,
  expectedChapterId: string,
  expectedWorkId: string,
): void {
  if (storedChapterId !== expectedChapterId) {
    throw new Error("화 파일 ID와 저장 경로가 일치하지 않습니다.");
  }
  if (storedWorkId !== expectedWorkId) {
    throw new Error("화 파일의 작품 ID와 저장 경로가 일치하지 않습니다.");
  }
}

/** File identity includes nanosecond change time, so atomic publication,
 * rollback, deletion/recreation and external edits invalidate the projection.
 * Full chapter payloads are never retained by this cache. */
async function chapterFileFingerprint(path: string): Promise<string | null> {
  try {
    const value = await stat(path, { bigint: true });
    return [
      value.dev,
      value.ino,
      value.size,
      value.mtimeNs,
      value.ctimeNs,
    ].join(":");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function createChapterSummaryCache(
  fingerprint: (
    path: string,
  ) => Promise<string | null> = chapterFileFingerprint,
  limit = 4096,
) {
  const entries = new Map<
    string,
    { stamp: string; summary: LibraryChapterSummary }
  >();
  return async (
    path: string,
    load: () => Promise<LibraryChapterSummary | null>,
  ): Promise<LibraryChapterSummary | null> => {
    const before = await fingerprint(path);
    const cached = entries.get(path);
    if (before !== null && cached?.stamp === before) {
      entries.delete(path);
      entries.set(path, cached);
      return { ...cached.summary };
    }
    entries.delete(path);
    // Read and validate through the original reader, including its ENOENT and
    // malformed-header behavior. A changed file must never reuse stale status.
    const summary = await load();
    const after = await fingerprint(path);
    if (summary && before !== null && before === after && limit > 0) {
      entries.set(path, { stamp: before, summary: { ...summary } });
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    }
    return summary;
  };
}

const readCachedChapterSummary = createChapterSummaryCache();

export function readChapterSummaryFile(workId: string, chapterId: string) {
  return readCachedChapterSummary(getChapterFilePath(workId, chapterId), () =>
    readChapterSummarySource(workId, chapterId),
  );
}
