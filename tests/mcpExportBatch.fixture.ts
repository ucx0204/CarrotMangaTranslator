import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { vi } from "vitest";
import { editingChapter } from "./mcpEditing.fixture";
import { McpArtifactStore } from "../src/main/mcp/mcpArtifactStore";
import { McpPageExportService } from "../src/main/application/mcpPageExportService";
import { McpExportBatchService } from "../src/main/application/mcpExportBatchService";
import type { McpOperationContext } from "../src/main/application/mcpOperationService";
import type { McpExportPageResult } from "../src/shared/mcpExportBatch";

const AdmZip = createRequire(import.meta.url)("adm-zip") as {
  new (bytes: Buffer): {
    getEntries(): { entryName: string; getData(): Buffer }[];
  };
};
export function readExportZip(bytes: Buffer) {
  return Object.fromEntries(
    new AdmZip(bytes)
      .getEntries()
      .map((entry) => [entry.entryName, entry.getData()]),
  );
}
export function exportFixture() {
  let now = Date.now();
  let permitted = true;
  const chapter = editingChapter();
  chapter.pages = [1, 2, 3].map((n) => ({
    ...structuredClone(chapter.pages[0]),
    id: `p${n}`,
  }));
  chapter.pageOrder = chapter.pages.map((page) => page.id);
  const store = new McpArtifactStore("https://export.test", () => now);
  const controller = new AbortController();
  const assertRetained = () => {
    if (!permitted) throw new Error("permission revoked");
  };
  const context: McpOperationContext = {
    id: randomUUID(),
    signal: controller.signal,
    assertAuthorized: () => {
      controller.signal.throwIfAborted();
      assertRetained();
    },
    progress: vi.fn(),
  };
  const openChapter = vi.fn(async () => structuredClone(chapter));
  const render = vi.fn(async (page: (typeof chapter.pages)[number]) =>
    Buffer.from(`PNG fixture ${page.id}`),
  );
  const exporter = new McpPageExportService({
    openChapter,
    render,
    store: store.put.bind(store),
    assertImageAccess: async () => {},
  });
  const reportError = vi.fn();
  const service = new McpExportBatchService({
    openChapter,
    reportError,
    exportPage: (target, job, retained) =>
      exporter.export(target, job, retained),
    archive: store.zip.bind(store),
    preflight: async (_chapter, ids) => ({
      workTitle: "fixture",
      chapterCount: 1,
      pageCount: ids.length,
      sampleRelativePath: "private-path-not-for-response",
      outputPolicy: "new-timestamped-folder",
      issues: [],
      targets: [],
    }),
  });
  const target = async (pageIds?: string[]) => {
    const plan = await service.preflight(
      { chapterId: chapter.id, pageIds },
      assertRetained,
    );
    return {
      chapterId: plan.chapterId,
      snapshot: plan.snapshot,
      pages: plan.pages.map(({ pageId, revision }) => ({ pageId, revision })),
      requestId: randomUUID(),
    };
  };
  const run = async () => service.run(await target(), context, assertRetained);
  const read = (url: string) => store.read(new URL(url).pathname.split("/")[2]);
  const zip = (result: Awaited<ReturnType<typeof run>>, allowPartial = false) =>
    service.zip(
      { sourceJobId: context.id, requestId: randomUUID(), allowPartial },
      { status: result.status, data: result.exportPages },
      {
        ...context,
        signal: new AbortController().signal,
        assertAuthorized: assertRetained,
      },
      assertRetained,
    );
  const file = (page: McpExportPageResult) => {
    if (!page.url) throw new Error("missing URL");
    return read(page.url);
  };
  return {
    chapter,
    service,
    store,
    context,
    controller,
    render,
    openChapter,
    reportError,
    assertRetained,
    target,
    run,
    read,
    zip,
    file,
    revoke: () => {
      permitted = false;
    },
    expire: () => {
      now += 10 * 60_000;
    },
    close: () => store.close(),
  };
}
