import { hashStableValue } from "../../shared/blockFingerprint";
import { McpEditError } from "../application/mcpEditPolicy";
import type {
  McpWorkflowRecord,
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

export async function reconcileNativeWorkflow(
  storage: McpRetentionStorage,
  record: McpWorkflowRecord,
  step: McpWorkflowStep,
  guard: () => void,
) {
  if (!step.attemptId) return undefined;
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
  const outcome = await withLibraryRead(async () => {
    if (step.stage === "export-png") {
      const { record: output } = await readRetainedOutput(
        storage,
        record.owner,
        entry.id,
      );
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
        await storage.path(entry.id, output.sha256),
      );
      if (bytes.sha256 !== output.sha256 || bytes.bytes !== output.bytes)
        throw new McpEditError(
          "revision_conflict",
          "Retained workflow output bytes changed.",
        );
      return { revision: page.revision, outputId: entry.id };
    }
    const { record: change } = await readRetainedChange(
      storage,
      record.owner,
      entry.id,
    );
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
    return { revision: page.revision, changeId: entry.id };
  });
  guard();
  return { page, outcome };
}
