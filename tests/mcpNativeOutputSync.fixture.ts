import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import { vi } from "vitest";
import { retentionFixture } from "./mcpRetention.fixture";
import type { MangaPage } from "../src/shared/libraryTypes";
import {
  mcpOutputSyncOutputs,
  type McpOutputSyncPreflight,
  type McpSyncOutput,
} from "../src/shared/mcpOutputSync";
import type { McpTool } from "../src/main/mcp/mcpReadTools";

/** Real library, app activities, native writers and encrypted receipts.
 * Only the established Electron/renderer boundary produces synthetic pixels. */
export async function nativeOutputSyncFixture() {
  const retained = await retentionFixture();
  await retained.operations().close();
  const electron = await import("electron");
  Object.assign(electron.app, { getVersion: () => "output-sync-integration" });
  const chapter = await seedNativeOutputSyncChapter(retained);
  const [selectedPage, secondPage] = chapter.pages;
  if (!selectedPage || !secondPage)
    throw new Error("Expected two saved native output-sync pages");
  const { LinkedWorkspaceSyncService } =
    await import("../src/main/linkedWorkspace/linkedWorkspaceSyncService");
  const { DEFAULT_RASTER_EXPORT_SETTINGS } =
    await import("../src/shared/linkedWorkspaceTypes");
  const { McpOutputSyncRepository } =
    await import("../src/main/mcp/mcpOutputSyncRepository");
  const { McpRetentionStorage } =
    await import("../src/main/mcp/mcpRetentionStorage");
  const { McpOperationService } =
    await import("../src/main/application/mcpOperationService");
  const { createMcpOutputSyncSession } =
    await import("../src/main/mcp/mcpOutputSyncSession");
  const { mcpToolResult } = await import("../src/main/mcp/mcpToolResult");
  const { mcpJobReceiptOutput } =
    await import("../src/main/mcp/mcpJobOutputSchema");
  const { setImageRedactionEnabled } =
    await import("../src/main/imageRedactionStore");
  const renderPage = vi.fn(async (page: MangaPage) =>
    Buffer.from("native-output:" + page.id),
  );
  const rendererClose = vi.fn();
  const cancel = vi.fn();
  const reportError = vi.fn();
  const output = join(retained.env.root, "approved-output");
  await mkdir(output);
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
    ],
  });
  const native = new LinkedWorkspaceSyncService({
    dataRoot: retained.env.root,
    jobs: retained.app.jobs,
    decodeImage: retained.app.decodeImage,
    getMainWindow: retained.app.getMainWindow,
    reportError: (_message, error) => reportError(error),
    dependencies: {
      listLibrary: retained.library.listLibrary,
      openChapter: retained.library.openChapter,
      updatePagesAfterInpainting: retained.library.updatePagesAfterInpainting,
      createPageExportRenderSession: async () => ({
        renderPage,
        close: rendererClose,
        cancel,
      }),
    },
  });
  await native.initialize();
  await native.connect({
    workId: chapter.workId,
    chapterId: chapter.id,
    rootPath: output,
    output: {
      ...DEFAULT_RASTER_EXPORT_SETTINGS,
      format: "png",
      destinationMode: "fixed",
    },
    enqueueExistingPages: false,
  });
  const connectionId = native.getStatus(chapter.id).connectionId;
  if (!connectionId) throw new Error("fixture connection missing");
  const selection = {
    chapterId: chapter.id,
    connectionId,
    pageIds: [selectedPage.id],
  };
  let allowed = true;
  const owner = "native-sync-owner";
  const assertAllowed = () => {
    if (!allowed) throw new Error("fixture authorization revoked");
  };
  const auth = () => ({
    principalId: owner,
    assertAuthorized: assertAllowed,
    assertScopes: vi.fn((_scopes: readonly string[]) => assertAllowed()),
    assertJobAuthorized: vi.fn((_scopes?: readonly string[]) =>
      assertAllowed(),
    ),
  });
  const preferences = {
    allowEditing: true,
    allowProcessing: true,
    allowImages: true,
    autoStart: false,
  };
  const open = () => {
    const operations = new McpOperationService(reportError);
    const storage = new McpRetentionStorage(retained.codec, Date.now, (id) =>
      repository.isActive(id),
    );
    const repository: InstanceType<typeof McpOutputSyncRepository> =
      new McpOutputSyncRepository(storage);
    const session = createMcpOutputSyncSession({
      app: retained.app,
      operations,
      repository,
      port: native.reviewedOutput,
      preferences,
      editing: { assertClean: retained.editing.assertWritable },
      reportError,
    });
    return { operations, repository, storage, session };
  };
  let current = open();
  const invoke = async (
    name: string,
    input: object,
    caller: Parameters<McpTool["invoke"]>[1] = auth(),
  ) => {
    const tool = current.session.tools.find((tool) => tool.name === name);
    if (!tool) throw new Error("fixture tool missing: " + name);
    const response = mcpToolResult(
      tool,
      await tool.invoke(input as Record<string, unknown>, caller),
    );
    if (response.isError)
      throw new Error(JSON.stringify(response.structuredContent));
    return response.structuredContent;
  };
  const request = (review: McpOutputSyncPreflight) => ({
    chapterId: review.chapterId,
    connectionId: review.connectionId,
    pageIds: review.pageIds,
    selectionSnapshot: review.selectionSnapshot,
    destinationSnapshot: review.destinationSnapshot,
    sourceSnapshot: review.sourceSnapshot,
    requestId: randomUUID(),
    confirm: true as const,
    acknowledgePartialPublication: true as const,
    acknowledgeSavedTextMirror: true as const,
  });
  const closeCurrent = async () => {
    current.session.stop();
    current.operations.stop();
    await current.session.close();
    await current.operations.close();
  };
  return {
    retained,
    chapter,
    selectedPageId: selectedPage.id,
    secondPageId: secondPage.id,
    native,
    output,
    selection,
    owner,
    renderPage,
    rendererClose,
    cancel,
    reportError,
    auth,
    preferences,
    current: () => current,
    invoke,
    request,
    revoke: () => {
      allowed = false;
    },
    preflight: async () =>
      mcpOutputSyncOutputs.carrot_preflight_output_sync.parse(
        await invoke("carrot_preflight_output_sync", selection),
      ),
    start: async (input: McpSyncOutput) =>
      mcpJobReceiptOutput.parse(await invoke("carrot_sync_output", input)),
    receipt: async (requestId: string) =>
      mcpOutputSyncOutputs.carrot_get_output_sync.parse(
        await invoke("carrot_get_output_sync", { requestId }),
      ),
    redaction: (enabled: boolean) =>
      setImageRedactionEnabled(enabled, retained.env.root),
    queue: () =>
      readFile(join(retained.env.root, "linked-sync-queue.json"), "utf8"),
    wait: (jobId: string) =>
      current.operations.waitForCompletion(
        jobId,
        owner,
        new AbortController().signal,
      ),
    restart: async () => {
      await closeCurrent();
      current = open();
    },
    close: async () => {
      try {
        await closeCurrent();
      } finally {
        try {
          await native.dispose();
        } finally {
          vi.useRealTimers();
          await retained.close();
        }
      }
    },
  };
}

async function seedNativeOutputSyncChapter(
  retained: Awaited<ReturnType<typeof retentionFixture>>,
) {
  const source = await retained.snapshot();
  const { createLibraryImportService } =
    await import("../src/main/library/libraryImportFacade");
  const { withLibraryMutation } = await import("../src/main/library/lock");
  const importer = createLibraryImportService({
    runMutation: withLibraryMutation,
    // Match the existing import fixture's external decoder boundary. Native
    // UUID allocation, image checks, saved paths and transactions remain real.
    image: {
      validateImageFile: async (path) => {
        PNG.sync.read(await readFile(path));
      },
      convertWebpToPngFile: async () => {
        throw new Error("No WebP conversion in this PNG fixture");
      },
    },
  });
  const draftId = randomUUID();
  const imported = await importer.createImport({
    preview: {
      mode: "batch",
      sourceKind: "images",
      suggestedWorkTitle: "Native output sync fixture",
      chapters: [
        {
          draftId,
          title: "Native linked output",
          sourceKind: "images",
          pages: source.pages.map((page, index) => ({
            name: index === 0 ? "selected.png" : "mirror-only.png",
            sourcePath: page.imagePath,
            sourceKind: "file",
          })),
        },
      ],
    },
    target: { mode: "new", title: "Native output sync fixture" },
    selections: [{ draftId, title: "Native linked output", enabled: true }],
  });
  const chapter = await retained.library.openChapter(imported.chapterIds[0]);
  return retained.library.savePagesBlocks({
    chapterId: chapter.id,
    pages: chapter.pages.map((page, index) => ({
      pageId: page.id,
      blocks: source.pages[index].blocks,
    })),
  });
}

export function outputSyncDeferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
