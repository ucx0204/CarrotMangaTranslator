import {
  McpImportReceiptSchema,
  mcpLibraryImportOutputs,
} from "../../shared/mcpLibraryImport";
import { McpWorkFileReceiptSchema } from "../../shared/mcpWorkFileImport";
import {
  McpImportBatchReferenceSchema,
  mcpImportBatchOutputs,
} from "../../shared/mcpImportBatch";
import { McpTypographyAnalysisObservationSchema } from "../../shared/mcpTypographyAnalysis";
import { McpLetteringPlanReferenceSchema } from "../../shared/mcpLettering";
import { McpSoundEffectPlanReferenceSchema } from "../../shared/mcpSoundEffects";
import type {
  McpCompositeGuard,
  McpCompositeOutcome,
  McpCompositeSavedBinding,
} from "../application/mcpCompositeWorkflowPorts";
import { compositeFingerprint } from "../application/mcpCompositeWorkflowPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpCompositeNativeCalls } from "./mcpCompositeNativeCalls";
import type { CompositeNativeJob } from "./mcpCompositeNativeReceipts";
import type { CompositeNativeOptions } from "./mcpCompositeNativeResolve";
import { compositeNativeFamily } from "./mcpCompositeNativeDispatch";
import { createCompositeNativeReader } from "./mcpCompositeNativeTools";
import { readCompositeNativeBatch } from "./mcpCompositeNativeBatches";

/** A completed admission is useful only while its exact native result can still be proved. */
export async function verifyCompositeNativeResult(
  options: CompositeNativeOptions,
  calls: McpCompositeNativeCalls,
  binding: McpCompositeSavedBinding,
  outcome: McpCompositeOutcome,
  guard: McpCompositeGuard,
): Promise<McpCompositeOutcome> {
  if (
    outcome.status !== "completed" ||
    compositeNativeFamily(binding.family).mode !== "job"
  )
    return outcome;
  const job = await calls.findJob(binding);
  if (
    !job ||
    job.jobId !== outcome.receipt.id ||
    job.status !== "completed" ||
    !job.result
  )
    throw unavailableResult();
  if (
    binding.family === "import-create" ||
    binding.family === "work-file-import"
  ) {
    const mapping = await readCompositeImportMapping(
      options,
      binding,
      job,
      guard,
    );
    return {
      ...outcome,
      imported: {
        selectionFingerprint: mapping.selectionFingerprint,
        items: mapping.items.map(({ itemKey, page }) => ({
          itemKey,
          page: {
            workId: page.workId,
            chapterId: page.chapterId,
            pageId: page.pageId,
            blockIds: [],
          },
        })),
      },
    };
  }
  return verifyOtherJobResult(options, binding, outcome, job, guard);
}
export async function readCompositeImportMapping(
  options: CompositeNativeOptions,
  binding: McpCompositeSavedBinding,
  job: CompositeNativeJob,
  guard: McpCompositeGuard,
) {
  const read = createCompositeNativeReader(options.tools);
  const request = { requestId: binding.nativeRequestId };
  const observed =
    binding.family === "import-create"
      ? McpImportReceiptSchema.parse(job.result?.importReceipt)
      : McpWorkFileReceiptSchema.parse(job.result?.workFileReceipt);
  const receipt =
    binding.family === "import-create"
      ? await read(
          mcpLibraryImportOutputs.carrot_get_import_receipt,
          "carrot_get_import_receipt",
          request,
          binding.owner,
          guard,
        )
      : await read(
          McpWorkFileReceiptSchema,
          "carrot_get_work_file_import",
          request,
          binding.owner,
          guard,
        );
  if (
    receipt.requestId !== binding.nativeRequestId ||
    receipt.id !== observed.id ||
    !receipt.pageMapping ||
    compositeFingerprint(receipt.pageMapping) !==
      compositeFingerprint(observed.pageMapping)
  )
    throw unavailableResult();
  return receipt.pageMapping;
}
async function verifyOtherJobResult(
  options: CompositeNativeOptions,
  binding: McpCompositeSavedBinding,
  outcome: McpCompositeOutcome,
  job: CompositeNativeJob,
  guard: McpCompositeGuard,
) {
  switch (binding.family) {
    case "import-batch-run": {
      const completed = await completedImportBatch(
        options,
        binding,
        job,
        guard,
      );
      return {
        ...outcome,
        status: completed ? ("completed" as const) : ("partial" as const),
      };
    }
    case "typography-analyze": {
      const value = McpTypographyAnalysisObservationSchema.parse(
        job.result?.typographyAnalysis,
      );
      if (value.expiresAt <= Date.now()) throw unavailableResult();
      return outcome;
    }
    case "lettering-prepare": {
      const result = McpLetteringPlanReferenceSchema.parse(
        job.result?.letteringPlan,
      );
      await readCompositeNativeBatch(
        options,
        binding.owner,
        "lettering-apply",
        result.batchId,
        guard,
      );
      return outcome;
    }
    case "sfx-prepare": {
      const result = McpSoundEffectPlanReferenceSchema.parse(
        job.result?.soundEffectPlan,
      );
      await readCompositeNativeBatch(
        options,
        binding.owner,
        "sfx-apply",
        result.batchId,
        guard,
      );
      return {
        ...outcome,
        status: result.failedItems
          ? ("partial" as const)
          : ("completed" as const),
      };
    }
    default:
      return verifyOutputJob(options, binding, outcome, job);
  }
}
async function completedImportBatch(
  options: CompositeNativeOptions,
  binding: McpCompositeSavedBinding,
  job: CompositeNativeJob,
  guard: McpCompositeGuard,
) {
  const read = createCompositeNativeReader(options.tools);
  const result = McpImportBatchReferenceSchema.parse(job.result?.importBatch);
  const view = await read(
    mcpImportBatchOutputs.carrot_get_import_batch,
    "carrot_get_import_batch",
    { id: result.id },
    binding.owner,
    guard,
  );
  if (view.id !== result.id || view.version !== result.version)
    throw unavailableResult();
  return (
    ["completed", "review_required"].includes(view.status) &&
    view.items.every((item) => ["ready", "imported"].includes(item.status))
  );
}
function verifyOutputJob(
  options: CompositeNativeOptions,
  binding: McpCompositeSavedBinding,
  outcome: McpCompositeOutcome,
  job: CompositeNativeJob,
) {
  if (binding.family === "images-export") {
    const source = options.operations.exportSource(job.jobId, binding.owner);
    const exported = source.data.pages.filter(
      (page) => page.status === "exported",
    );
    for (const page of exported)
      if (
        !options.operations.outputMetadata(
          job.jobId,
          binding.owner,
          page.pageId,
        )
      )
        throw unavailableResult();
    return {
      ...outcome,
      status:
        exported.length === source.data.total
          ? ("completed" as const)
          : ("partial" as const),
    };
  }
  if (
    [
      "work-file-export",
      "zip-export",
      "text-export",
      "context-export",
    ].includes(binding.family)
  ) {
    if (!options.operations.outputMetadata(job.jobId, binding.owner))
      throw unavailableResult();
    return outcome;
  }
  throw unavailableResult();
}
function unavailableResult() {
  return new McpEditError(
    "not_found",
    "The exact native result or reviewed import mapping is unavailable; this phase cannot advance.",
  );
}
