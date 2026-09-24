import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { exportFixture } from "./mcpExportBatch.fixture";
import { McpExportBatchService } from "../src/main/application/mcpExportBatchService";
import { McpPageExportService } from "../src/main/application/mcpPageExportService";
import { readMcpExportSourceName } from "../src/main/mcp/mcpSourceExport";
import type { McpBatchExportOptions } from "../src/shared/mcpExportBatch";

export const sourcePolicy = {
  format: "source",
  omitText: false,
  jpegQuality: 85,
  webpQuality: 92,
  unsupportedSource: "png",
} as const;

export function sourceExportFixture() {
  const f = exportFixture();
  f.chapter.pages = [
    "private-source.png",
    "private-source.JPEG",
    "nested/private-source.webp",
    "private-source.tif",
  ].map((sourceFileName, index) => ({
    ...structuredClone(f.chapter.pages[0]),
    id: `p${index + 1}`,
    name: "private-display-name.bmp",
    sourceFileName,
  }));
  f.chapter.pageOrder = f.chapter.pages.map((page) => page.id);
  const exporter = new McpPageExportService({
    openChapter: f.openChapter,
    render: f.render,
    store: f.store.put.bind(f.store),
    image: { render: f.renderImage, store: f.store.putImage.bind(f.store) },
    assertImageAccess: async () => f.assertRetained(),
    // Native file hashes and the codec are external fixture boundaries here.
    // Actual native saved-name retention is covered by mcpSourceRetention.
    bindSource: async (page) => ({
      fingerprint: "a".repeat(16),
      sourceNameFingerprint:
        readMcpExportSourceName(page).sourceNameFingerprint,
      verify: async () => {},
    }),
  });
  const preflight = vi.fn(
    async (_chapter: typeof f.chapter, ids: string[]) => ({
      workTitle: "fixture",
      chapterCount: 1,
      pageCount: ids.length,
      sampleRelativePath: "private-native-path",
      outputPolicy: "new-timestamped-folder" as const,
      issues: [],
      targets: [],
    }),
  );
  const service = new McpExportBatchService({
    openChapter: f.openChapter,
    readSourceName: readMcpExportSourceName,
    reportError: f.reportError,
    preflight,
    archive: f.store.zip.bind(f.store),
    exportPage: (target, job, retained) =>
      target.imageExport
        ? exporter.exportImage(
            { ...target, imageExport: target.imageExport },
            job,
            retained,
          )
        : exporter.export(target, job, retained),
  });
  const plan = (
    pageIds?: string[],
    imageExport: McpBatchExportOptions = sourcePolicy,
  ) =>
    service.preflight(
      { chapterId: f.chapter.id, pageIds, imageExport },
      f.assertRetained,
    );
  const target = async (
    pageIds?: string[],
    imageExport: McpBatchExportOptions = sourcePolicy,
  ) => {
    const review = await plan(pageIds, imageExport);
    return {
      chapterId: review.chapterId,
      snapshot: review.snapshot,
      pages: review.pages.map(({ pageId, revision }) => ({ pageId, revision })),
      requestId: randomUUID(),
      imageExport,
    };
  };
  const run = async (pageIds?: string[]) =>
    service.run(await target(pageIds), f.context, f.assertRetained);
  const zip = (result: Awaited<ReturnType<typeof run>>, allowPartial = false) =>
    service.zip(
      { sourceJobId: f.context.id, requestId: randomUUID(), allowPartial },
      { status: result.status, data: result.exportPages },
      {
        ...f.context,
        signal: new AbortController().signal,
        assertAuthorized: f.assertRetained,
      },
      f.assertRetained,
    );
  return { ...f, service, preflight, plan, target, run, zip };
}
