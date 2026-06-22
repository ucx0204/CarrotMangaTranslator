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
  parseIpcPayload,
} from "../../shared/ipcSchemas";
import { libraryIpcContracts } from "../../shared/ipcContracts";
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
  savePageBlocks,
} from "../library";
import { createLibraryImageUrl } from "../imageProtocol";
import type { IpcContext } from "./context";
import { trustedHandleContract } from "./trustedIpc";

export function registerLibraryIpc(context: IpcContext): void {
  registerLibraryReadIpc(context);
  registerLibraryRenameIpc(context);
  registerLibraryDeleteIpc(context);
  registerLibraryReorderIpc(context);
}

function registerLibraryReadIpc(context: IpcContext): void {
  trustedHandleContract(context, libraryIpcContracts.getLibrary, async () =>
    listLibrary(),
  );
  trustedHandleContract(
    context,
    libraryIpcContracts.openLibraryFolder,
    async () => {
      const error = await shell.openPath(getLibraryRoot());
      return {
        opened: !error,
        libraryPath: getLibraryRoot(),
        ...(error ? { error } : {}),
      };
    },
  );
  trustedHandleContract(
    context,
    libraryIpcContracts.openChapter,
    async (_event, chapterId: unknown) => {
      const request = parseIpcPayload(
        OpenChapterRequestSchema,
        { chapterId },
        "화 열기",
      );
      return openChapter(request.chapterId);
    },
  );
  trustedHandleContract(
    context,
    libraryIpcContracts.getPageImageDataUrl,
    async (_event, imagePath: unknown) => {
      const request = parseIpcPayload(
        ImageDataUrlRequestSchema,
        { imagePath },
        "페이지 이미지 열기",
      );
      return createLibraryImageUrl(request.imagePath);
    },
  );
  trustedHandleContract(
    context,
    libraryIpcContracts.savePageBlocks,
    async (_event, raw: unknown) =>
      savePageBlocks(
        parseIpcPayload(SavePageBlocksRequestSchema, raw, "페이지 블록 저장"),
      ),
  );
}

function registerLibraryRenameIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    libraryIpcContracts.renameWork,
    async (_event, workId: unknown, title: unknown) => {
      const request = parseIpcPayload(
        RenameWorkRequestSchema,
        { workId, title },
        "작품 이름 변경",
      );
      return renameWork(request.workId, request.title);
    },
  );
  trustedHandleContract(
    context,
    libraryIpcContracts.renameChapter,
    async (_event, chapterId: unknown, title: unknown) => {
      const request = parseIpcPayload(
        RenameChapterRequestSchema,
        { chapterId, title },
        "화 이름 변경",
      );
      return renameChapter(request.chapterId, request.title);
    },
  );
}

function registerLibraryDeleteIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    libraryIpcContracts.deleteWork,
    async (_event, workId: unknown) => {
      const request = parseIpcPayload(
        DeleteWorkRequestSchema,
        { workId },
        "작품 삭제",
      );
      return deleteWork(request.workId);
    },
  );
  trustedHandleContract(
    context,
    libraryIpcContracts.deleteChapter,
    async (_event, chapterId: unknown) => {
      const request = parseIpcPayload(
        DeleteChapterRequestSchema,
        { chapterId },
        "화 삭제",
      );
      return deleteChapter(request.chapterId);
    },
  );
  trustedHandleContract(
    context,
    libraryIpcContracts.deletePage,
    async (_event, chapterId: unknown, pageId: unknown) => {
      const request = parseIpcPayload(
        DeletePageRequestSchema,
        { chapterId, pageId },
        "페이지 삭제",
      );
      return deletePage(request.chapterId, request.pageId);
    },
  );
}

function registerLibraryReorderIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    libraryIpcContracts.reorderChapters,
    async (_event, workId: unknown, chapterIds: unknown) => {
      const request = parseIpcPayload(
        ReorderChaptersRequestSchema,
        { workId, chapterIds },
        "화 순서 변경",
      );
      return reorderChapters(request.workId, request.chapterIds);
    },
  );
  trustedHandleContract(
    context,
    libraryIpcContracts.reorderPages,
    async (_event, chapterId: unknown, pageIds: unknown) => {
      const request = parseIpcPayload(
        ReorderPagesRequestSchema,
        { chapterId, pageIds },
        "페이지 순서 변경",
      );
      return reorderPages(request.chapterId, request.pageIds);
    },
  );
}
