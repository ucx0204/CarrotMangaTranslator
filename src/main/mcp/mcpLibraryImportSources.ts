import type { McpUploadedImport } from "../../shared/mcpFileUploads";
import type { McpFileUploadStore } from "./mcpFileUploadStore";
import { verifyUploadFile } from "./mcpImageUploadFiles";
import { dialog, type OpenDialogOptions } from "electron";
import { rm } from "node:fs/promises";
import type { PreparedImportPreview } from "../../shared/importTypes";
import type { PreparedMcpImport } from "../application/mcpLibraryImportTypes";
import type {
  McpChooseImport,
  McpScanImport,
} from "../../shared/mcpLibraryImport";
import type { McpDiscoverChapters } from "../../shared/mcpChapterDiscovery";
import type { WebImportProgressEvent } from "../../shared/webImportTypes";
import type { McpOperationContext } from "../application/mcpOperationService";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  previewImages,
  previewFolder,
  prepareArchiveImportPreview,
  prepareArchiveFolderImportPreview,
  preparePdfImportPreview,
} from "../library/libraryImportFacade";
import { isZipArchivePath } from "../libraryStore/importSources";
import { WebImportSessionManager } from "../webImportSessionManager";
import {
  createMcpImportTemporaryRoot,
  freezeMcpImport,
} from "./mcpLibraryImportStaging";

type Options = {
  dataRoot: string;
  uploads?: McpFileUploadStore;
  reportError: (error: unknown) => void;
  choose?: (input: McpChooseImport) => Promise<string[]>;
  web?: Pick<
    WebImportSessionManager,
    "scan" | "prepareImport" | "discardSession" | "dispose"
  > &
    Partial<Pick<WebImportSessionManager, "discoverChapters">>;
};
/** UI preview sessions and their shared directories are deliberately never used. */
export class McpLibraryImportSources {
  private web?: Promise<NonNullable<Options["web"]>>;
  private directory?: string;
  private readonly discoveries = new Set<Promise<unknown>>();
  constructor(private readonly options: Options) {}
  async prepare(
    input: McpChooseImport | McpScanImport | McpUploadedImport,
    context: McpOperationContext,
    owner?: string,
  ) {
    try {
      context.assertAuthorized();
      if (input.source === "web") return await this.scan(input, context);
      if ("uploadId" in input)
        return await this.uploaded(owner, input, context);
      const paths = await (this.options.choose ?? chooseNativeFiles)(input);
      context.assertAuthorized();
      if (!paths.length) return undefined;
      const prepared = await localPreview(input, paths, context);
      return await freezeMcpImport(prepared, this.options.dataRoot, context);
    } catch (error) {
      context.assertAuthorized();
      if (error instanceof McpEditError) throw error;
      this.options.reportError(error);
      throw new McpEditError(
        "invalid_edit",
        "The app could not prepare this input. Inspect the local import log; no library data was changed.",
      );
    }
  }
  private uploaded(
    owner: string | undefined,
    input: McpUploadedImport,
    context: McpOperationContext,
  ) {
    if (!owner || !this.options.uploads)
      throw new McpEditError(
        "access_denied",
        "Owned incoming-file input is unavailable.",
      );
    return this.options.uploads.withFile(
      owner,
      input.uploadId,
      context.assertAuthorized,
      async (asset) => {
        const extension = asset.input.filename.split(".").at(-1)?.toLowerCase();
        if (extension === "mgtshare")
          throw new McpEditError(
            "invalid_edit",
            "Editable working files require preview_work_file and import_work_file, not image import.",
          );
        const kind =
          extension === "pdf"
            ? "pdf"
            : ["zip", "cbz", "rar", "cbr"].includes(extension ?? "")
              ? "archive"
              : "images";
        if (input.kind !== kind)
          throw new McpEditError(
            "invalid_edit",
            "Selected input kind disagrees with the uploaded filename. No parser was run.",
          );
        const verify = () =>
          verifyUploadFile(
            asset.path,
            asset.input.bytes,
            asset.input.sha256,
            asset.guard,
          );
        await verify();
        const prepared = await localPreview(input, [asset.path], {
          ...context,
          assertAuthorized: asset.guard,
        });
        if (input.kind === "images")
          for (const chapter of prepared.preview.chapters)
            for (const page of chapter.pages) page.name = asset.input.filename;
        const frozen = await freezeMcpImport(
          prepared,
          this.options.dataRoot,
          { ...context, assertAuthorized: asset.guard },
          [
            "Source is explicitly uploaded bytes. The frozen preview is independent of the temporary upload.",
          ],
        );
        try {
          await verify();
          asset.guard();
          return frozen;
        } catch (error) {
          await frozen.cleanup();
          throw error;
        }
      },
    );
  }
  discover(input: McpDiscoverChapters, context: McpOperationContext) {
    const pending = this.discoverPage(input, context);
    this.discoveries.add(pending);
    return pending.finally(() => this.discoveries.delete(pending));
  }
  private async discoverPage(
    input: McpDiscoverChapters,
    context: McpOperationContext,
  ) {
    context.assertAuthorized();
    const manager = await this.manager();
    context.assertAuthorized();
    if (!manager.discoverChapters)
      throw new McpEditError(
        "invalid_edit",
        "This native web provider does not support chapter-link inspection.",
      );
    const { requestId, url, pathPrefix, maxLinks } = input;
    const response = await manager.discoverChapters(
      { requestId, url, pathPrefix, maxLinks },
      context.signal,
      webProgress(context),
    );
    context.assertAuthorized();
    if (response.status !== "ready")
      throw new McpEditError(
        "invalid_edit",
        `Chapter discovery rejected: ${response.reason}. No chapters were imported.`,
      );
    return response.result;
  }
  private async manager() {
    this.web ??= (async () => {
      if (this.options.web) return this.options.web;
      this.directory = await createMcpImportTemporaryRoot(
        this.options.dataRoot,
        "mcp-web-import-",
      );
      return new WebImportSessionManager({
        dataRoot: this.directory,
        reportError: (_message, detail) => this.options.reportError(detail),
      });
    })();
    return this.web;
  }
  private async scan(input: McpScanImport, context: McpOperationContext) {
    const manager = await this.manager();
    context.assertAuthorized();
    const response = await manager.scan(
      input,
      context.signal,
      webProgress(context),
    );
    if (response.status !== "ready")
      throw new McpEditError(
        "invalid_edit",
        `Web import rejected: ${response.reason}. No library data was changed.`,
      );
    const result = response.result;
    let frozen: PreparedMcpImport | undefined;
    try {
      try {
        context.assertAuthorized();
        if (!result.candidates.length || result.candidates.length > 500)
          throw new McpEditError(
            "invalid_edit",
            "Web preview requires one to five hundred candidates. It was not silently truncated.",
          );
        const prepared = await manager.prepareImport(
          result.sessionId,
          result.candidates.map((candidate) => candidate.id),
          context.signal,
        );
        frozen = await freezeMcpImport(
          prepared,
          this.options.dataRoot,
          context,
          [
            `Web discovery truncated: ${result.truncated}; skipped unsupported=${result.skipped.unsupported}, failed=${result.skipped.failed}, duplicate=${result.skipped.duplicate}, blocked=${result.skipped.blocked}.`,
            "This is image discovery for one URL, not exhaustive chapter discovery or an authenticated website session.",
          ],
        );
      } finally {
        await manager.discardSession(result.sessionId);
      }
      return frozen;
    } catch (error) {
      // Until native-session cleanup completes no caller owns the captured input.
      // Release it on either preparation or cleanup failure before rejecting.
      await frozen?.cleanup();
      throw error;
    }
  }
  async close() {
    const manager = await this.web;
    await manager?.dispose();
    await Promise.allSettled([...this.discoveries]);
    if (this.directory)
      await rm(this.directory, { recursive: true, force: true });
  }
}
function webProgress(context: McpOperationContext) {
  return (progress: WebImportProgressEvent) => {
    context.assertAuthorized();
    context.progress({
      phase: `import-${progress.stage}`,
      completed: progress.completed,
      total: progress.total,
    });
  };
}
async function chooseNativeFiles(input: McpChooseImport): Promise<string[]> {
  const directory = input.kind === "folder" || input.kind === "chapter-folder";
  const options: OpenDialogOptions = {
    title:
      "MCP import: choose only files you authorize this AI connection to inspect and import",
    properties: directory
      ? ["openDirectory"]
      : input.kind === "images"
        ? ["openFile", "multiSelections"]
        : ["openFile"],
    ...(!directory
      ? {
          filters: [
            {
              name: "Import input",
              extensions:
                input.kind === "images"
                  ? ["png", "jpg", "jpeg", "webp"]
                  : input.kind === "pdf"
                    ? ["pdf"]
                    : ["zip", "cbz", "rar", "cbr"],
            },
          ],
        }
      : {}),
  };
  const result = await dialog.showOpenDialog(options);
  return result.canceled ? [] : result.filePaths;
}
function validateLocalSelection(input: McpChooseImport, paths: string[]) {
  if (paths.length > 500 || (input.kind !== "images" && paths.length !== 1))
    throw new McpEditError(
      "invalid_edit",
      "Choose one container/folder or at most five hundred image files.",
    );
  const native =
    input.kind === "pdf" ||
    input.kind === "chapter-folder" ||
    (input.kind === "archive" && !isZipArchivePath(paths[0]));
  if (native && !input.allowNativePreparation)
    throw new McpEditError(
      "access_denied",
      "Explicit native import-runtime preparation permission is required for PDF, RAR or chapter-folder input.",
    );
}
async function localPreview(
  input: McpChooseImport,
  paths: string[],
  context: McpOperationContext,
): Promise<PreparedImportPreview> {
  validateLocalSelection(input, paths);
  const progress = () => {
    context.assertAuthorized();
    context.progress({ phase: "preparing-import-source" });
  };
  if (input.kind === "images") return { preview: await previewImages(paths) };
  if (input.kind === "folder")
    return { preview: await previewFolder(paths[0]) };
  if (input.kind === "archive")
    return prepareArchiveImportPreview(paths[0], context.signal, progress);
  if (input.kind === "pdf")
    return preparePdfImportPreview(paths[0], context.signal, progress);
  return prepareArchiveFolderImportPreview(paths[0], context.signal, progress);
}
