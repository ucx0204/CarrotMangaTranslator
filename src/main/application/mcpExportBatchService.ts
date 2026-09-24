import type { ChapterSnapshot } from "../../shared/libraryTypes";
import type { PageImageExportPreflightResult } from "../../shared/pageImageExportTypes";
import type { McpPageExportOptions } from "../../shared/mcpOutputFormats";
import {
  McpExportPagesMetadataSchema,
  type McpExportPagesTarget,
  type McpExportZipTarget,
  type McpExportPageResult,
  type McpBatchExportOptions,
} from "../../shared/mcpExportBatch";
import type { McpOperationContext } from "./mcpOperationService";
import type { McpPageExportService } from "./mcpPageExportService";
import { McpEditError } from "./mcpEditPolicy";
import {
  assertMcpExportSelection,
  mcpExportSnapshot,
  selectMcpExportPages,
  mcpExportPageMetadata,
  type McpExportSourceNameReader,
} from "./mcpExportSelection";

type PageExport = ReturnType<McpPageExportService["exportImage"]>;
type Archive = Pick<
  Awaited<PageExport>,
  "url" | "bytes" | "sha256" | "expiresAt" | "access"
> & {
  mimeType:
    | "image/png"
    | "image/jpeg"
    | "image/webp"
    | "image/vnd.adobe.photoshop"
    | "application/zip";
};
type Ports = {
  openChapter: (id: string) => Promise<ChapterSnapshot>;
  readSourceName?: McpExportSourceNameReader;
  preflight: (
    chapter: ChapterSnapshot,
    pageIds: string[],
    imageExport?: McpBatchExportOptions,
  ) => Promise<PageImageExportPreflightResult>;
  exportPage: (
    target: {
      chapterId: string;
      pageId: string;
      revision: string;
      requestId: string;
      imageExport?: McpPageExportOptions;
      sourceNameFingerprint?: string;
    },
    context: McpOperationContext,
    retainedAccess: () => Promise<void>,
  ) => Promise<
    Awaited<PageExport | ReturnType<McpPageExportService["export"]>>
  >;
  archive: (
    files: { url: string; filename: string }[],
    manifest: unknown,
    assertAccess: () => Promise<void>,
    signal: AbortSignal,
  ) => Promise<Archive>;
  reportError: (error: unknown) => void;
};
export type McpExportSource = {
  status: string;
  data: {
    chapterId: string;
    snapshot: string;
    total: number;
    completed: number;
    pages: McpExportPageResult[];
    imageExport?: McpBatchExportOptions;
  };
};
/** Sequential saved-page export. No model execution, text writes or second job queue. */
export class McpExportBatchService {
  constructor(private readonly ports: Ports) {}

  async preflight(
    input: {
      chapterId: string;
      pageIds?: string[];
      imageExport?: McpBatchExportOptions;
    },
    assertAccess: () => void,
  ) {
    assertAccess();
    const chapter = await this.ports.openChapter(input.chapterId);
    const pages = selectMcpExportPages(
      chapter,
      input.pageIds,
      input.imageExport,
      this.ports.readSourceName,
    );
    const snapshot = mcpExportSnapshot(chapter, input.imageExport, pages);
    const result = await this.ports.preflight(
      chapter,
      pages.map((page) => page.pageId),
      input.imageExport,
    );
    assertMcpExportSelection(
      await this.ports.openChapter(input.chapterId),
      {
        chapterId: input.chapterId,
        snapshot,
        pages,
        requestId: "00000000-0000-0000-0000-000000000000",
        ...(input.imageExport ? { imageExport: input.imageExport } : {}),
      },
      this.ports.readSourceName,
    );
    assertAccess();
    return {
      chapterId: input.chapterId,
      snapshot,
      ...(input.imageExport ? { imageExport: input.imageExport } : {}),
      pages: pages.map((page) => ({
        ...mcpExportPageMetadata(page),
        issues: result.issues
          .filter(
            (issue) =>
              issue.chapterId === chapter.id && issue.pageId === page.pageId,
          )
          .map(({ code, severity }) => ({ code, severity })),
      })),
      executionReserved: false as const,
      notChecked: [
        "live-editor-and-jobs",
        "image-transfer-and-redaction",
        "renderer-fonts-and-files",
        "output-budgets",
        "translation-quality",
      ],
    };
  }

  async run(
    target: McpExportPagesTarget,
    context: McpOperationContext,
    retainedAccess: () => void,
  ) {
    context.assertAuthorized();
    const chapter = await this.ports.openChapter(target.chapterId);
    const selected = assertMcpExportSelection(
      chapter,
      target,
      this.ports.readSourceName,
    );
    const pages: McpExportPageResult[] = selected.map((page) => ({
      ...mcpExportPageMetadata(page),
      status: "unprocessed",
    }));
    const assertShape = this.shapeGuard(target, retainedAccess);
    let status = "completed";
    for (const [index, page] of pages.entries()) {
      try {
        context.assertAuthorized();
        await assertShape();
        const artifact = await this.exportSelectedPage(
          target,
          selected[index],
          context,
          { index, total: pages.length, assertShape },
        );
        await assertShape();
        Object.assign(page, {
          status: "exported",
          url: artifact.url,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          expiresAt: artifact.expiresAt,
          ...(target.imageExport ? { mimeType: artifact.mimeType } : {}),
          ...(artifact.retainedOutputId
            ? { retainedOutputId: artifact.retainedOutputId }
            : {}),
        });
        context.progress({
          phase: "exporting",
          completed: index + 1,
          total: pages.length,
        });
      } catch (error) {
        if (!context.signal.aborted || error !== context.signal.reason)
          this.ports.reportError(error);
        page.status = context.signal.aborted ? "cancelled" : "failed";
        page.code = error instanceof McpEditError ? error.code : page.status;
        status = context.signal.aborted
          ? "cancelled"
          : index > 0
            ? "partial"
            : "failed";
        break;
      }
    }
    const completed = pages.filter((page) => page.status === "exported").length;
    context.progress({ phase: status, completed, total: pages.length });
    return batchResult(target, pages, completed, status);
  }

  private exportSelectedPage(
    target: McpExportPagesTarget,
    page: ReturnType<typeof selectMcpExportPages>[number],
    context: McpOperationContext,
    progress: {
      index: number;
      total: number;
      assertShape: () => Promise<void>;
    },
  ) {
    return this.ports.exportPage(
      {
        chapterId: target.chapterId,
        pageId: page.pageId,
        revision: page.revision,
        requestId: target.requestId,
        ...(target.imageExport
          ? {
              imageExport:
                target.imageExport.format === "source"
                  ? page.imageExport
                  : target.imageExport,
            }
          : {}),
        ...(page.sourceNameFingerprint
          ? {
              sourceNameFingerprint: page.sourceNameFingerprint,
            }
          : {}),
      },
      {
        ...context,
        progress: ({ phase }) =>
          context.progress({
            phase,
            completed: progress.index,
            total: progress.total,
          }),
      },
      progress.assertShape,
    );
  }

  private shapeGuard(target: McpExportPagesTarget, retainedAccess: () => void) {
    return async () => {
      retainedAccess();
      const latest = await this.ports.openChapter(target.chapterId);
      const sourcePages =
        target.imageExport?.format === "source"
          ? selectMcpExportPages(
              latest,
              target.pages.map((page) => page.pageId),
              target.imageExport,
              this.ports.readSourceName,
            )
          : undefined;
      if (
        latest.id !== target.chapterId ||
        mcpExportSnapshot(latest, target.imageExport, sourcePages) !==
          target.snapshot
      )
        throw new McpEditError(
          "revision_conflict",
          "Chapter membership or page order changed. Run export preflight again.",
        );
      retainedAccess();
    };
  }

  async zip(
    target: McpExportZipTarget,
    source: McpExportSource,
    context: McpOperationContext,
    retainedAccess: () => void,
  ) {
    const { data } = source;
    const partialOutput =
      source.status !== "completed" || data.completed !== data.total;
    if (partialOutput && !target.allowPartial)
      throw new McpEditError(
        "invalid_edit",
        "Source export is incomplete. Inspect page outcomes; allowPartial must be explicitly true for a partial ZIP.",
      );
    const pages = data.pages.filter((page) => page.status === "exported");
    if (!pages.length || pages.some((page) => !page.url))
      throw new McpEditError(
        "not_found",
        "Source image links are unavailable after expiry or restart. Inspect retained outputs or issue a new export.",
      );
    const assertAccess = async () => {
      retainedAccess();
      assertMcpExportSelection(
        await this.ports.openChapter(data.chapterId),
        {
          chapterId: data.chapterId,
          snapshot: data.snapshot,
          pages,
          requestId: target.requestId,
          ...(data.imageExport ? { imageExport: data.imageExport } : {}),
        },
        this.ports.readSourceName,
        data.pages.map((page) => page.pageId),
      );
      retainedAccess();
    };
    context.assertAuthorized();
    await assertAccess();
    context.progress({ phase: "packing", completed: 0, total: pages.length });
    const artifact = await this.ports.archive(
      pages.map(exportFile),
      {
        version: 1,
        sourceJobId: target.sourceJobId,
        partialOutput,
        ...McpExportPagesMetadataSchema.parse(data),
      },
      assertAccess,
      context.signal,
    );
    context.assertAuthorized();
    await assertAccess();
    context.progress({
      phase: "done",
      completed: pages.length,
      total: pages.length,
    });
    return {
      ...artifact,
      kind: "rendered-pages-zip",
      filename: "carrot-pages.zip",
      sourceJobId: target.sourceJobId,
      pageCount: pages.length,
      partialOutput,
      performed: ["zip"],
    };
  }
}
function batchResult(
  target: McpExportPagesTarget,
  pages: McpExportPageResult[],
  completed: number,
  status: string,
) {
  return {
    kind: target.imageExport ? "rendered-pages-images" : "rendered-pages-png",
    status,
    performed: ["render", "export"],
    exportPages: {
      chapterId: target.chapterId,
      snapshot: target.snapshot,
      total: pages.length,
      completed,
      pages,
      ...(target.imageExport ? { imageExport: target.imageExport } : {}),
    },
  };
}
function exportFile(page: McpExportPageResult) {
  if (!page.url)
    throw new McpEditError("not_found", "Exported image is unavailable.");
  return { url: page.url, filename: page.filename };
}
