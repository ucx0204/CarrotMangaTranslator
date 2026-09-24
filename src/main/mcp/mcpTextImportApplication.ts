import { hashStableValue } from "../../shared/blockFingerprint";
import { McpTranslationBatchGetSchema } from "../../shared/mcpTranslationBatch";
import {
  McpTextImportPreviewSchema,
  McpTextImportApplySchema,
  type McpTextImportApply,
} from "../../shared/mcpTextExchange";
import { McpPageBatchService } from "../application/mcpPageBatchService";
import type { McpPageEditService } from "../application/mcpPageEditService";
import type {
  McpOperationService,
  McpOperationContext,
} from "../application/mcpOperationService";
import {
  createMcpTextImportPolicy,
  type McpTextImportSourcePort,
  type McpTextImportRequest,
  type McpTextImportPlan,
} from "../application/mcpTextImportPolicy";
import {
  applyMcpTextImportSnapshots,
  assertTextImportPageName,
} from "../application/mcpReviewImportPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import { createMcpPageBatchPorts } from "./mcpTranslationBatchAdapter";
import { checkMcpTextExchangeBinding } from "./mcpTextExportSource";
import { logError } from "../logger";

const notes = [
  "explicit_selected_blocks_only_no_model_or_render",
  "page_by_page_commits_prior_completed_pages_survive_failure_or_cancellation",
  "keep_upload_until_operation_settles",
  "session_preview_is_not_durable_use_retained_change_tools_for_recovery",
  "review_tables_edit_only_source_translation_review_status_and_note",
];

export class McpTextImportApplication {
  private readonly batches;
  constructor(
    private readonly sources: McpTextImportSourcePort,
    edits: McpPageEditService,
    private readonly operations: McpOperationService,
    lifetime?: AbortSignal,
  ) {
    this.batches = new McpPageBatchService(
      createImportPorts(edits),
      createMcpTextImportPolicy(sources, checkMcpTextExchangeBinding),
      Date.now,
      lifetime,
    );
  }
  close() {
    return this.batches.close();
  }
  async preview(
    owner: string,
    value: unknown,
    guard: () => void,
    signal?: AbortSignal,
  ) {
    const input = McpTextImportPreviewSchema.parse(value);
    const summary = await this.batches.preview(owner, input, guard, signal);
    const plan = this.batches.readOwnedPlan(owner, summary.batchId, guard);
    return {
      ...summary,
      input: plan.input,
      diagnosticCount: plan.diagnostics.length,
      application: "page-by-page" as const,
      notes: [...notes],
    };
  }
  async inspect(owner: string, value: unknown, guard: () => void) {
    const input = McpTranslationBatchGetSchema.parse(value);
    const summary = await this.batches.inspect(owner, input, guard);
    const plan = this.batches.readOwnedPlan(owner, input.batchId, guard);
    return {
      ...summary,
      input: plan.input,
      diagnosticCount: plan.diagnostics.length,
      application: "page-by-page" as const,
      notes: [...notes],
      diagnostics: plan.diagnostics.slice(
        input.offset,
        input.offset + input.limit,
      ),
      nextDiagnosticOffset:
        input.offset + input.limit < plan.diagnostics.length
          ? input.offset + input.limit
          : null,
    };
  }
  async apply(owner: string, value: unknown, guard: () => void) {
    const input = McpTextImportApplySchema.parse(value);
    // Admit/replay before consulting the temporary upload or session-only plan.
    return this.operations.start({
      owner,
      requestId: input.requestId,
      kind: "textFileImport",
      parameters: input,
      assertAuthorized: guard,
      execute: (job) => this.run(owner, input, guard, job),
    });
  }
  private async run(
    owner: string,
    input: McpTextImportApply,
    guard: () => void,
    job: McpOperationContext,
  ) {
    const plan = this.batches.readOwnedPlan(owner, input.batchId, guard);
    job.assertAuthorized();
    let outcome:
      | Awaited<ReturnType<typeof this.batches.waitForAction>>
      | undefined;
    try {
      return await this.consumeImport(
        owner,
        input,
        guard,
        job,
        plan,
        (value) => {
          outcome = value;
        },
      );
    } catch (error) {
      if (!outcome) throw error;
      // Already committed pages remain authoritative even if final source checking
      // or upload-lease cleanup fails. Preserve the original cause at the boundary.
      logError("MCP text import completion check failed", error);
      const saved = outcome.pages.filter(
        (page) => page.result === "saved",
      ).length;
      const status = job.signal.aborted
        ? "cancelled"
        : saved
          ? "partial"
          : "failed";
      return {
        kind: "text-file-import",
        batchId: input.batchId,
        status,
        input: plan.input,
        application: "page-by-page",
        outcome,
        performed: ["apply"],
        completionCheck: {
          status: "failed",
          code:
            error instanceof McpEditError
              ? error.code
              : "completion_check_failed",
        },
      };
    }
  }
  private consumeImport(
    owner: string,
    input: McpTextImportApply,
    guard: () => void,
    job: McpOperationContext,
    plan: McpTextImportPlan,
    settled: (
      value: Awaited<ReturnType<typeof this.batches.waitForAction>>,
    ) => void,
  ) {
    return this.sources.use(
      owner,
      {
        uploadId: plan.input.uploadId,
        format: plan.input.format,
        sha256: plan.input.sha256,
      },
      guard,
      async (source) => {
        if (hashStableValue(source.info) !== hashStableValue(plan.input))
          throw new McpEditError(
            "revision_conflict",
            "The reviewed uploaded text changed.",
          );
        await source.verify();
        await checkMcpTextExchangeBinding(plan.source, guard, job.signal);
        job.assertAuthorized();
        job.progress({
          phase: "applying",
          completed: 0,
          total: plan.pages.length,
        });
        this.batches.start(
          owner,
          { batchId: input.batchId, requestId: input.requestId },
          "apply",
          guard,
        );
        const outcome = await this.batches.waitForAction(
          owner,
          input.batchId,
          input.requestId,
          job.signal,
        );
        settled(outcome);
        await source.verify();
        const saved = outcome.pages.filter(
          (page) => page.result === "saved",
        ).length;
        job.progress({
          phase: outcome.status,
          completed: saved,
          total: outcome.pages.length,
        });
        return {
          kind: "text-file-import",
          batchId: input.batchId,
          status: outcome.status,
          input: plan.input,
          application: "page-by-page",
          outcome,
          performed: ["apply"],
        };
      },
      job.signal,
    );
  }
}

function createImportPorts(edits: McpPageEditService) {
  return createMcpPageBatchPorts<McpTextImportRequest>(
    (request, membership, guard, committed, scope) => {
      const namedScope = <T>(run: () => Promise<T>) =>
        scope(async () => {
          // Runs only after this page's real edit handoff and context read lease.
          const page = await edits.readStructurePage(request);
          assertTextImportPageName(page, request.pageName);
          guard();
          return run();
        });
      return request.kind === "txt"
        ? edits.commitTranslationBatch(
            request,
            membership,
            guard,
            committed,
            namedScope,
          )
        : edits.commitSnapshotBatch(
            request,
            membership,
            guard,
            committed,
            namedScope,
            applyMcpTextImportSnapshots,
          );
    },
  );
}
