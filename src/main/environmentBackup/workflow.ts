import type { LibraryPageRecord } from "../../shared/libraryTypes";
import {
  workflowRegionKey,
  workflowStageKey,
} from "../../shared/pageWorkflowPolicy";
import { PAGE_WORKFLOW_STAGES } from "../../shared/pageWorkflowStages";

/** Rebind only fingerprints that still match the saved page, keeping stale work stale. */
export function relocateBackupWorkflow(
  before: LibraryPageRecord,
  after: LibraryPageRecord,
): void {
  const oldPage = { ...before, dataUrl: "" };
  for (const block of before.blocks) {
    if (
      before.erasedWorkflowRegions?.[block.id] ===
      workflowRegionKey(oldPage, block)
    ) {
      after.erasedWorkflowRegions = {
        ...after.erasedWorkflowRegions,
        [block.id]: workflowRegionKey({ ...after, dataUrl: "" }, block),
      };
    }
  }
  const receipt = after.pageWorkflow;
  if (!receipt) return;
  const newPage = { ...after, dataUrl: "" };
  if (receipt.emptyDetectionKey === workflowStageKey(oldPage, "detect"))
    receipt.emptyDetectionKey = workflowStageKey(newPage, "detect");
  for (const stage of PAGE_WORKFLOW_STAGES) {
    const step = receipt.steps[stage];
    if (!step) continue;
    const oldKey = workflowStageKey(oldPage, stage);
    const newKey = workflowStageKey(newPage, stage);
    for (const key of ["inputKey", "outputKey", "resumeKey"] as const)
      if (step[key] === oldKey) step[key] = newKey;
  }
}
