import { shell } from "electron";
import {
  DeleteChapterRequestSchema,
  DeletePageRequestSchema,
  DeleteWorkRequestSchema,
  ImageDataUrlRequestSchema,
  OpenChapterRequestSchema,
  RenameChapterRequestSchema,
  RenameWorkRequestSchema,
  ReorderChaptersRequestSchema,
  ReorderPagesRequestSchema,
  SavePageBlocksRequestSchema,
  parseIpcPayload
} from "../../shared/ipcSchemas";
import {
  deleteChapter,
  deletePage,
  deleteWork,
  getLibraryRoot,
  listLibrary,
  openChapter,
  renameChapter,
  renameWork,
  reorderChapters,
  reorderPages,
  savePageBlocks
} from "../library";
import { createLibraryImageUrl } from "../imageProtocol";
import type { IpcContext } from "./context";
import { trustedHandle } from "./trustedIpc";

export function registerLibraryIpc(context: IpcContext): void {
  trustedHandle(context, "library:get-index", async () => listLibrary());
  trustedHandle(context, "library:open-folder", async () => {
    const error = await shell.openPath(getLibraryRoot());
    return { opened: !error, libraryPath: getLibraryRoot(), ...(error ? { error } : {}) };
  });
  trustedHandle(context, "library:open-chapter", async (_event, chapterId: unknown) => {
    const request = parseIpcPayload(OpenChapterRequestSchema, { chapterId }, "화 열기");
    return openChapter(request.chapterId);
  });
  trustedHandle(context, "library:get-page-image-data-url", async (_event, imagePath: unknown) => {
    const request = parseIpcPayload(ImageDataUrlRequestSchema, { imagePath }, "페이지 이미지 열기");
    return createLibraryImageUrl(request.imagePath);
  });
  trustedHandle(context, "library:save-page-blocks", async (_event, raw: unknown) =>
    savePageBlocks(parseIpcPayload(SavePageBlocksRequestSchema, raw, "페이지 블록 저장"))
  );
  trustedHandle(context, "library:rename-work", async (_event, workId: unknown, title: unknown) => {
    const request = parseIpcPayload(RenameWorkRequestSchema, { workId, title }, "작품 이름 변경");
    return renameWork(request.workId, request.title);
  });
  trustedHandle(context, "library:rename-chapter", async (_event, chapterId: unknown, title: unknown) => {
    const request = parseIpcPayload(RenameChapterRequestSchema, { chapterId, title }, "화 이름 변경");
    return renameChapter(request.chapterId, request.title);
  });
  trustedHandle(context, "library:delete-work", async (_event, workId: unknown) => {
    const request = parseIpcPayload(DeleteWorkRequestSchema, { workId }, "작품 삭제");
    return deleteWork(request.workId);
  });
  trustedHandle(context, "library:delete-chapter", async (_event, chapterId: unknown) => {
    const request = parseIpcPayload(DeleteChapterRequestSchema, { chapterId }, "화 삭제");
    return deleteChapter(request.chapterId);
  });
  trustedHandle(context, "library:reorder-chapters", async (_event, workId: unknown, chapterIds: unknown) => {
    const request = parseIpcPayload(ReorderChaptersRequestSchema, { workId, chapterIds }, "화 순서 변경");
    return reorderChapters(request.workId, request.chapterIds);
  });
  trustedHandle(context, "library:reorder-pages", async (_event, chapterId: unknown, pageIds: unknown) => {
    const request = parseIpcPayload(ReorderPagesRequestSchema, { chapterId, pageIds }, "페이지 순서 변경");
    return reorderPages(request.chapterId, request.pageIds);
  });
  trustedHandle(context, "library:delete-page", async (_event, chapterId: unknown, pageId: unknown) => {
    const request = parseIpcPayload(DeletePageRequestSchema, { chapterId, pageId }, "페이지 삭제");
    return deletePage(request.chapterId, request.pageId);
  });
}
