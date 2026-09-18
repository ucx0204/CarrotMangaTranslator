import { createPageRevision } from "../../shared/pageRevision";
import type {
  BatchChange,
  BatchPlan,
  BatchTarget,
  BatchPolicy,
  BatchCommit,
} from "./mcpPageBatchTypes";
import type { McpTranslationPatch } from "../../shared/mcpEditingTypes";
import type { McpTranslationBatchDirection } from "../../shared/mcpTranslationBatch";
import { McpEditError } from "./mcpEditPolicy";

export type BatchTextRun = {
  requestId: string;
  direction: McpTranslationBatchDirection;
  controller: AbortController;
  status: "running" | "completed" | "partial" | "failed" | "cancelled";
  failure?: unknown;
};
export type BatchTextCommit = BatchCommit<McpTranslationPatch>;

/** A sequence of ordinary page edits, NOT a model queue or a chapter-wide lock.
 * Each committed page is acknowledged before renderer notifications can fail. */
export async function runMcpPageBatch<
  I extends BatchTarget,
  C extends BatchChange,
  R,
  P extends BatchPlan<C>,
>(
  plan: P,
  target: I,
  run: BatchTextRun,
  commit: BatchCommit<R>,
  guard: () => void,
  touch: () => void,
  makeRequest: BatchPolicy<I, C, R, unknown, P>["request"],
): Promise<void> {
  const required = { apply: "pending", undo: "applied", redo: "undone" }[
    run.direction
  ];
  const pages = plan.pages.filter((page) => page.state === required);
  let saved = 0;
  for (const page of pages) {
    page.result = "not_started";
    page.errorCode = null;
  }
  for (const page of pages) {
    try {
      guard();
      await commit(
        makeRequest(page, target, run.direction, plan),
        {
          workId: plan.workId,
          membership: plan.membership,
          contextRevision:
            run.direction === "undo" ? null : target.contextRevision,
        },
        guard,
        (updated) => {
          page.state = run.direction === "undo" ? "undone" : "applied";
          page.expectedRevision = createPageRevision(updated);
          page.result = "saved";
          saved += 1;
          touch();
        },
      );
    } catch (error) {
      // Keep committed state even if a post-commit notification failed.
      if (page.result !== "saved")
        page.result = run.controller.signal.aborted ? "cancelled" : "failed";
      page.errorCode = run.controller.signal.aborted
        ? "cancelled"
        : error instanceof McpEditError
          ? error.code
          : "save_failed";
      run.failure = error;
      run.status = saved
        ? "partial"
        : run.controller.signal.aborted
          ? "cancelled"
          : "failed";
      return;
    }
  }
  run.status = "completed";
}
