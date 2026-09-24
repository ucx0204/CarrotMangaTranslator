import { createHash, randomUUID } from "node:crypto";
import { vi } from "vitest";
import { typographyAnalysisAppFixture } from "./mcpTypographyAnalysisApp.fixture";
import {
  buildReviewRows,
  serializeReviewRows,
} from "../src/shared/reviewTable";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";
import { McpTextImportPreviewSchema } from "../src/shared/mcpTextExchange";
import type { McpTextExchangeOptions } from "../src/shared/mcpExchangeFiles";
import type { McpFileUploadStore as FileUploadStore } from "../src/main/mcp/mcpFileUploadStore";

/** Native library, handoff, context lease, upload and batch service. The writable
 * acknowledgement is the only renderer boundary controlled by these tests. */
export async function textExchangeAppFixture() {
  const f = await typographyAnalysisAppFixture();
  const { McpFileUploadStore } =
    await import("../src/main/mcp/mcpFileUploadStore");
  const { McpTextImportSource } =
    await import("../src/main/mcp/mcpTextImportSource");
  const { McpTextImportApplication } =
    await import("../src/main/mcp/mcpTextImportApplication");
  const { McpOperationService } =
    await import("../src/main/application/mcpOperationService");
  const { McpPageEditService } =
    await import("../src/main/application/mcpPageEditService");
  const { createMcpPageEditScope } =
    await import("../src/main/mcp/mcpPageEditScope");
  const { readMcpTextExportSource } =
    await import("../src/main/mcp/mcpTextExportSource");
  const uploads = new McpFileUploadStore();
  const errors: unknown[] = [];
  const operations = new McpOperationService((error) => errors.push(error));
  const { assertWritable, pauseWritable } = writableBoundary();
  const notifySaved = vi.fn();
  const edits = new McpPageEditService({
    withPageEdit: createMcpPageEditScope(f.app, f.library.openChapter),
    openChapter: f.library.openChapter,
    savePageBlocks: f.library.savePageBlocks,
    assertWritable,
    notifySaved,
  });
  const owner = "text-import-owner";
  const guard = vi.fn();
  const sources = new McpTextImportSource(uploads);
  const imports = new McpTextImportApplication(sources, edits, operations);
  const upload = (content: string, format: McpTextExchangeOptions["format"]) =>
    uploadText(uploads, owner, guard, content, format);
  const prepare = async (
    format: McpTextExchangeOptions["format"] = "csv",
    pageIds = ["page", "second"],
  ) => {
    const options: McpTextExchangeOptions =
      format === "txt"
        ? { format, field: "translated", includeHeaders: true }
        : { format, includeBom: true };
    const source = await readMcpTextExportSource(
      { chapterId: "chapter", pageIds, options },
      guard,
    );
    const saved = await f.library.readWorkContextForEdit("chapter");
    const rows = buildReviewRows(
      saved.chapter,
      source.binding.direction,
      new Set(pageIds),
    );
    for (const row of rows.filter((row) => row.block_id === "a")) {
      row.source_text = `source from file: ${row.page_id}`;
      row.translated_text = ` =SUM(1,2)\r\n"literal" ${row.page_id} `;
      row.review_status = "reviewed";
      row.review_note = ` note\t${row.page_id} `;
    }
    const content =
      format === "txt"
        ? source.bytes.toString("utf8").replaceAll("original-a", "imported-a")
        : serializeReviewRows(rows, format, true);
    const uploaded = await upload(content, format);
    const input = McpTextImportPreviewSchema.parse({
      source: source.binding,
      uploadId: uploaded.uploadId,
      sha256: uploaded.sha256,
      contextRevision: mcpContextRevision(saved),
      requestId: randomUUID(),
      reason: "Apply the explicitly selected uploaded review text",
      selection: pageIds.map((pageId) => ({ pageId, blockIds: ["a"] })),
      updateSourceText: format !== "txt",
      requireSourceMatch: format === "txt",
    });
    const preview = await imports.preview(owner, input, guard);
    return { preview, input, uploaded };
  };
  return {
    ...f,
    uploads,
    operations,
    imports,
    sources,
    owner,
    guard,
    errors,
    assertWritable,
    notifySaved,
    upload,
    prepareImport: prepare,
    pauseWritable,
    snapshot: () => f.library.openChapter("chapter"),
    apply: (batchId: string, requestId = randomUUID()) =>
      imports.apply(
        owner,
        {
          batchId,
          requestId,
          acknowledgePageByPage: true,
        },
        guard,
      ),
    done: (jobId: string) =>
      operations.waitForCompletion(jobId, owner, new AbortController().signal),
    inspect: (batchId: string) => imports.inspect(owner, { batchId }, guard),
    close: async () => {
      await imports.close();
      await operations.close();
      await uploads.close();
      await f.close();
    },
  };
}

async function uploadText(
  uploads: FileUploadStore,
  owner: string,
  guard: () => void,
  content: string,
  format: McpTextExchangeOptions["format"],
) {
  const bytes = Buffer.from(content, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const receipt = await uploads.begin(
    owner,
    {
      requestId: randomUUID(),
      filename: `review.${format}`,
      bytes: bytes.length,
      sha256,
    },
    null,
    guard,
  );
  await uploads.chunk(
    owner,
    {
      uploadId: receipt.uploadId,
      offset: 0,
      data: bytes.toString("base64"),
    },
    guard,
  );
  await uploads.finish(owner, receipt.uploadId, guard);
  return { uploadId: receipt.uploadId, sha256, bytes };
}

function writableBoundary() {
  const assertWritable = vi.fn<
    (_chapterId: string, pageId: string) => Promise<void>
  >(async () => {});
  const pauseWritable = (pageId: string) => {
    let entered!: () => void;
    let release!: () => void;
    let pending = true;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    assertWritable.mockImplementation(async (_chapterId, currentPage) => {
      if (pending && currentPage === pageId) {
        pending = false;
        entered();
        await blocked;
      }
    });
    return { reached, release };
  };
  return { assertWritable, pauseWritable };
}
