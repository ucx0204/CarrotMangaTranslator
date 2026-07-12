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
import { tMain } from "./localization";
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
        tMain("ipc.labels.chapterOpen"),
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
        tMain("ipc.labels.pageImageOpen"),
      );
      return createLibraryImageUrl(request.imagePath);
    },
  );
  trustedHandleContract(
    context,
    libraryIpcContracts.savePageBlocks,
    async (_event, raw: unknown) =>
      savePageBlocks(
        parseIpcPayload(
          SavePageBlocksRequestSchema,
          raw,
          tMain("ipc.labels.pageBlocksSave"),
        ),
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
        tMain("ipc.labels.workRename"),
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
        tMain("ipc.labels.chapterRename"),
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
        tMain("ipc.labels.workDelete"),
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
        tMain("ipc.labels.chapterDelete"),
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
        tMain("ipc.labels.pageDelete"),
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
        tMain("ipc.labels.chapterReorder"),
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
        tMain("ipc.labels.pageReorder"),
      );
      return reorderPages(request.chapterId, request.pageIds);
    },
  );
}
