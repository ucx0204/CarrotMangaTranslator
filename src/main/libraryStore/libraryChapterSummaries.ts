import { z } from "zod";
import { LibraryChapterFileSchema } from "../../shared/ipcSchemas";
import { MAX_PAGES_PER_REQUEST } from "../../shared/ipcSchemaPrimitives";
import type { LibraryChapterSummary } from "../../shared/libraryTypes";
import { assertUniqueIds, readLibraryJsonFile } from "./libraryJsonValidation";
import { getChapterFilePath } from "./libraryPaths";
import { readJsonFile } from "./storage";

const LibraryChapterSummarySourceSchema = LibraryChapterFileSchema.pick({
  id: true,
  workId: true,
  title: true,
  sourceKind: true,
  status: true,
  pageOrder: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  pages: z.array(z.unknown()).max(MAX_PAGES_PER_REQUEST),
});

export async function readChapterSummaryFile(
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
    status: chapter.status,
    createdAt: chapter.createdAt,
    updatedAt: chapter.updatedAt,
    pageCount: chapter.pages.length,
  };
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
