import { hashStableValue } from "../../shared/blockFingerprint";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpOperationService } from "../application/mcpOperationService";
import { mcpJobTargetSchema } from "../application/mcpJobJournal";
import type {
  McpWorkflowRecord,
  McpWorkflowOutcome,
  McpWorkflowStep,
} from "../application/mcpWorkflowPolicy";
import { withLibraryRead } from "../library/lock";
import { readRetainedChange } from "./mcpRecoveryInspection";
import { readRetainedOutput, checkOutputPages } from "./mcpRetainedOutputs";
import { inspectRetainedFile } from "./mcpRetentionEvidence";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import {
  assertWorkflowIdentity,
  readWorkflowPage,
} from "./mcpWorkflowEvidence";

/** A durable page save alone cannot prove erasure completion. Check the distinct
 * native job receipt for the same owner, request and original page revision. */
export async function workflowErasureCompleted(
  operations: McpOperationService,
  record: McpWorkflowRecord,
  step: McpWorkflowStep,
  guard: () => void,
) {
  guard();
  if (step.stage !== "erase" || !step.jobId || !step.attemptId) return false;
  await operations.ready();
  guard();
  let job: ReturnType<McpOperationService["status"]>;
  try {
    job = operations.status(step.jobId, record.owner);
  } catch (error) {
    if (error instanceof McpEditError && error.code === "not_found")
      return false;
    throw error;
  }
  const page = record.pages[step.pageIndex];
  const expected = {
    chapterId: page.chapterId,
    pageId: page.pageId,
    revision: page.revision,
    requestId: step.attemptId,
  };
  const target = mcpJobTargetSchema.safeParse(job.target);
  if (
    job.kind !== "erase" ||
    job.requestId !== step.attemptId ||
    !target.success ||
    hashStableValue(target.data) !== hashStableValue(expected)
  )
    throw new McpEditError(
      "revision_conflict",
      "Native erasure receipt belongs to a different workflow attempt.",
    );
  return completeErasure(job);
}
function completeErasure(job: ReturnType<McpOperationService["status"]>) {
  const result = job.result;
  return (
    job.status === "completed" &&
    result?.status === "completed" &&
    !result.cleanupFailed &&
    result.blocksIncomplete === 0
  );
}

export async function reconcileNativeWorkflow(
  storage: McpRetentionStorage,
  record: McpWorkflowRecord,
  step: McpWorkflowStep,
  guard: () => void,
  nativeCompleted = false,
) {
  if (!step.attemptId) return undefined;
  // Unknown or partial erasure remains review-required instead of being repeated.
  if (step.stage === "erase" && !nativeCompleted) return undefined;
  const expected = record.pages[step.pageIndex];
  const operation = {
    ocr: "carrot_run_page_ocr",
    erase: "carrot_run_page_erasure",
    translate: "carrot_apply_selection_batch",
    "export-png": "carrot_export_page_png",
    "await-external": "",
  }[step.stage];
  const candidates = await withLibraryRead(async () =>
    (await storage.index()).entries.filter(
      (entry) =>
        entry.owner === record.owner &&
        entry.operation === operation &&
        entry.requestId === step.attemptId,
    ),
  );
  if (!candidates.length) return undefined;
  if (candidates.length !== 1)
    throw new McpEditError(
      "invalid_edit",
      "Ambiguous durable workflow receipts; inspect native history.",
    );
  const entry = candidates[0];
  const { evidence: page } = await readWorkflowPage(expected, guard);
  assertWorkflowIdentity(expected, page);
  const outcome = await withLibraryRead<McpWorkflowOutcome>(() =>
    step.stage === "export-png"
      ? reconcileOutput(storage, record.owner, entry.id, expected, page)
      : reconcileChange(storage, record.owner, entry.id, expected, page),
  );
  guard();
  return {
    page,
    outcome: { ...outcome, outcome: "reconciled_native_receipt" },
  };
}
async function reconcileOutput(
  storage: McpRetentionStorage,
  owner: string,
  id: string,
  expected: McpWorkflowRecord["pages"][number],
  page: McpWorkflowRecord["pages"][number],
) {
  const { record: output } = await readRetainedOutput(storage, owner, id);
  if (
    output.targets.length !== 1 ||
    output.targets[0].pageId !== expected.pageId ||
    output.targets[0].chapterId !== expected.chapterId ||
    output.targets[0].revision !== expected.revision ||
    hashStableValue(page) !== hashStableValue(expected)
  )
    throw new McpEditError(
      "revision_conflict",
      "Historical output does not match this workflow attempt.",
    );
  await checkOutputPages(output, true);
  const bytes = await inspectRetainedFile(
    await storage.path(id, output.sha256),
  );
  if (bytes.sha256 !== output.sha256 || bytes.bytes !== output.bytes)
    throw new McpEditError(
      "revision_conflict",
      "Retained workflow output bytes changed.",
    );
  return { revision: page.revision, outputId: id };
}
async function reconcileChange(
  storage: McpRetentionStorage,
  owner: string,
  id: string,
  expected: McpWorkflowRecord["pages"][number],
  page: McpWorkflowRecord["pages"][number],
) {
  const { record: change } = await readRetainedChange(storage, owner, id);
  const saved = change.pages[0];
  if (
    change.pages.length !== 1 ||
    saved.chapterId !== expected.chapterId ||
    saved.before.page.id !== expected.pageId ||
    saved.before.fingerprint !== expected.fingerprint ||
    saved.after.fingerprint !== page.fingerprint ||
    saved.contextRevision !== expected.contextRevision ||
    saved.membership !== expected.membership
  )
    throw new McpEditError(
      "revision_conflict",
      "Current content conflicts with the saved workflow step.",
    );
  return { revision: page.revision, changeId: id };
}
