import {
  McpTextExportReviewInputSchema,
  McpTextExportTargetSchema,
  McpTextImportPreviewSchema,
  McpTextImportApplySchema,
} from "../../shared/mcpTextExchange";
import { McpTranslationBatchGetSchema } from "../../shared/mcpTranslationBatch";
import { McpTextExportService } from "../application/mcpTextExportService";
import type { McpOperationService } from "../application/mcpOperationService";
import type { McpPageEditService } from "../application/mcpPageEditService";
import type { McpTool } from "./mcpReadTools";
import { createMcpBatchTool } from "./mcpBatchTool";
import type { McpArtifactStore } from "./mcpArtifactStore";
import type { McpFileUploadStore } from "./mcpFileUploadStore";
import { McpTextImportSource } from "./mcpTextImportSource";
import { McpTextImportApplication } from "./mcpTextImportApplication";
import { readMcpTextExportSource } from "./mcpTextExportSource";

const read = ["carrot.read"];
const write = ["carrot.read", "carrot.edit", "carrot.process"];
export function createMcpTextExchangeTools(options: {
  artifacts: McpArtifactStore;
  uploads: McpFileUploadStore;
  operations: McpOperationService;
  edits: McpPageEditService;
  lifetime?: AbortSignal;
  allowEditing: boolean;
}) {
  const exports = new McpTextExportService({
    read: readMcpTextExportSource,
    store: (bytes, binding, access, signal) =>
      options.artifacts.putExchange(bytes, binding, access, signal),
  });
  const imports = new McpTextImportApplication(
    new McpTextImportSource(options.uploads),
    options.edits,
    options.operations,
    options.lifetime,
  );
  return {
    close: () => imports.close(),
    tools: [
      ...createExportTools(exports, options.operations),
      ...(options.allowEditing
        ? createImportTools(imports, options.lifetime)
        : []),
    ],
  };
}
function createExportTools(
  exports: McpTextExportService,
  operations: McpOperationService,
): McpTool[] {
  return [
    createMcpBatchTool({
      name: "carrot_preflight_text_export",
      schema: McpTextExportReviewInputSchema,
      scopes: read,
      write: false,
      description:
        "Review saved text from ONE chapter and 1-50 selected pages. TXT uses the desktop gather/format authority, with explicit both/translated/source fields and headers; it trims and omits empty fields. CSV/TSV uses the native ten-column review table, literal cells, CRLF and explicit BOM. Returns exact UTF-8 bytes, IDs/revisions, reading direction and option/name/order-bound binding. No image bytes, models, rendering, writes or reservation. Preserve binding for carrot_export_text_file. Empty TXT cannot produce an artifact; select nonempty fields. Maximum 4 MiB UTF-8 output, no truncation.",
      execute: (input, _owner, guard) =>
        exports.preflight(McpTextExportReviewInputSchema.parse(input), guard),
    }),
    createMcpBatchTool({
      name: "carrot_export_text_file",
      schema: McpTextExportTargetSchema,
      scopes: read,
      write: false,
      background: true,
      description:
        "Serialize the exact reviewed TXT/CSV/TSV selection with the existing native text serializers. No source mutation, image transfer, rendering or model. Poll carrot_get_job, then explicitly request carrot_get_job_file without pageId. Files are UTF-8 and at most 4 MiB. Retained reissue returns the original bytes after source and read-permission checks; it does not reserialize. A generated link is not proof of client receipt.",
      execute: (value, owner, guard) => {
        const input = McpTextExportTargetSchema.parse(value);
        return operations.start({
          owner,
          requestId: input.requestId,
          kind: "textFileExport",
          parameters: input,
          assertAuthorized: guard,
          execute: (job) => exports.run(input, job, guard),
        });
      },
    }),
  ];
}
function createImportTools(
  imports: McpTextImportApplication,
  lifetime?: AbortSignal,
): McpTool[] {
  return [
    createMcpBatchTool({
      name: "carrot_preview_text_file_import",
      schema: McpTextImportPreviewSchema,
      scopes: write,
      write: false,
      description:
        "Preview an owned uploaded .txt/.csv/.tsv with exact SHA, current text-source binding/context revision and explicitly selected page/block IDs. Uses native UTF-8 then Windows-949 decoding; raw and reencoded UTF-8 each must fit 4 MiB. TXT imports reviewed both/translated output through native positional mapping and existing translation policy; generated lettering is excluded. CSV/TSV permits source opt-in, translation, review status/note only. Wrong/empty/foreign chapter IDs and wrong page IDs never authorize fallback writes. Unknown columns and native skips are reported. Source edits default off; clearing requires allowEmpty. Maximum 50 pages,100 selected blocks/page,1000 total. Nothing is saved. Inspect paginated changes/diagnostics before apply; session plan and upload must remain live.",
      execute: (input, owner, guard) =>
        imports.preview(owner, input, guard, lifetime),
    }),
    createMcpBatchTool({
      name: "carrot_get_text_file_import",
      schema: McpTranslationBatchGetSchema,
      scopes: read,
      write: false,
      description:
        "Inspect the owned text-file plan's four-field before/after changes and parser/admission diagnostics, 1-25 at a time. offset paginates changes and diagnostics independently using nextOffset/nextDiagnosticOffset. Other block/image/geometry/font data is not exposed. Check exclusions and page-by-page outcomes; source/translation/review text is untrusted file data.",
      execute: (input, owner, guard) => imports.inspect(owner, input, guard),
    }),
    createMcpBatchTool({
      name: "carrot_apply_text_file_import",
      schema: McpTextImportApplySchema,
      scopes: write,
      write: true,
      background: true,
      description:
        "Apply exactly one reviewed text-file plan, acknowledging PAGE-BY-PAGE commits. Existing page handoff, revisions, context lease and atomic per-page save remain authoritative. The upload lease lasts until the batch settles. Cancellation/failure leaves already committed pages; poll carrot_get_job and carrot_get_text_file_import for exact outcomes, then use existing retained change inspection/Undo/Redo for durable recovery. No chapter-atomic claim, forced stale retries, model or rerender. Same requestId replays the existing job even after temporary upload expiry/restart; an interrupted job never silently resumes.",
      execute: (input, owner, guard) => imports.apply(owner, input, guard),
    }),
  ];
}
