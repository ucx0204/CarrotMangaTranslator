import {
  McpSelectionOcrSchema, McpSelectionTranslationSchema, McpSelectionAnalysisGetSchema,
} from "../../shared/mcpSelectionAnalysis";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { McpOperationService } from "../application/mcpOperationService";
import { McpEditError } from "../application/mcpEditPolicy";
import { createMcpBatchTool } from "./mcpBatchTool";
import { createMcpSelectionAnalysisAdapter } from "./mcpSelectionAnalysisAdapter";

export function createMcpSelectionAnalysisSession(app: InpaintingJobContext, operations: McpOperationService, enabled: boolean, runtime?: Parameters<typeof createMcpSelectionAnalysisAdapter>[1]) {
  const lifetime = new AbortController();
  const adapter = createMcpSelectionAnalysisAdapter(app, runtime);
  const schemas = { selectionOcr: McpSelectionOcrSchema, selectionTranslation: McpSelectionTranslationSchema };
  const start = (kind: keyof typeof schemas) => ({ ...createMcpBatchTool({
    name: kind === "selectionOcr" ? "carrot_run_selection_ocr" : "carrot_run_selection_translation",
    schema: schemas[kind], scopes: ["carrot.read", "carrot.process"], write: false, background: true,
    description: description(kind),
    execute: async (value, owner, guard) => {
      const input = schemas[kind].parse(value);
      return operations.start({ owner, kind, requestId: input.requestId, parameters: input, assertAuthorized: guard,
        execute: (operation) => {
          const signal = AbortSignal.any([operation.signal, lifetime.signal]);
          return adapter.run(owner, input, { ...operation, signal, assertAuthorized: () => { signal.throwIfAborted(); operation.assertAuthorized(); } });
        },
      });
    },
  }), readOnly: false, destructive: false, openWorld: true });
  return {
    tools: [
      ...(enabled ? [start("selectionOcr"), start("selectionTranslation")] : []),
      createMcpBatchTool({
        name: "carrot_get_selection_analysis", schema: McpSelectionAnalysisGetSchema, scopes: ["carrot.read"], write: false,
        description: "Read an owned completed selected OCR/translation analysis, at most 10 items per page. Poll carrot_get_job first, then use result.selectionAnalysis.analysisId. Evidence expires 30 minutes after completion or at server restart. Includes exact target versions, exclusions, OCR subregions and overlap IDs, or individual translation proposals. Never runs models or saves edits. Current text may have changed: existing edit/create tools require a fresh page revision and an explicit reviewed result. This slice has no analysis-bound automatic apply or new block-reference editor.",
        execute: async (value, owner, guard) => {
          const input = McpSelectionAnalysisGetSchema.parse(value);
          guard(); lifetime.signal.throwIfAborted();
          const job = operations.status(input.analysisId, owner);
          if (job.status !== "completed" || job.result?.selectionAnalysis?.analysisId !== input.analysisId)
            throw new McpEditError("not_found", "A completed owned selection analysis is required.");
          return adapter.analyses.get(owner, input, guard);
        },
      }),
    ],
    stop: () => lifetime.abort(),
    close: async () => { lifetime.abort(); adapter.analyses.close(); },
  };
}
function description(kind: "selectionOcr" | "selectionTranslation") {
  const common = " Explicit one-chapter scope: at most 20 pages and 100 total selected targets. Fresh page/context revisions required. Returns a job receipt; poll carrot_get_job, then paginate carrot_get_selection_analysis. No page, block, translation-memory or image save. Results are published only after all targets and model cleanup succeed; failure/cancellation publishes no partial analysis. Cancel via carrot_cancel_job. No automatic paid retry, fallback, erasure, C23, rendering or output files. Request a new explicit analysis after failure or expiry.";
  return kind === "selectionOcr"
    ? "Run only native local OCR on selected saved source blocks or explicit original-image rectangles. Regions use the native page-crop OCR mode; saved blocks use the native known-block-crop mode. Coordinates are original pixels, with containing-pixel rounding reported. Original images are used even after erasure. Existing blocks are never replaced; overlap reports help review missing-text discoveries. Generated-image blocks are excluded. Explicit allowAssetDownloads=true permits the app's approved OCR preparation; installed-only mode is not exposed. Optional sourceLanguage applies only to this request." + common
    : "Translate only selected saved source strings through the existing text-only app model boundary. Exactly one model request per eligible block, sequentially; this is not a joint chapter translation. No OCR or image input. expectedEngine must match the configured provider. Gemma requires allowAssetDownloads=true; Codex/hosted HTTPS API requires allowExternal=true. Local compatible HTTP servers are not supported by this boundary. Existing nonempty translations are preserved unless preserveExistingTranslations=false is explicit; there is no invented manual/automatic translation flag. Generated and empty-source blocks are excluded. Optional sourceLanguage/targetLanguage/contextMode are task-local. Saved memory is read, never rewritten." + common;
}
