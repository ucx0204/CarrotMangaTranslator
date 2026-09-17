import { createPageRevision } from "../../shared/pageRevision";
import type { MangaPage } from "../../shared/libraryTypes";
import type { McpTranslationPatch } from "../../shared/mcpEditingTypes";
import type { McpTranslationBatchDirection } from "../../shared/mcpTranslationBatch";
import type { BatchTextPlan } from "./mcpTranslationBatchPolicy";
import { McpEditError } from "./mcpEditPolicy";

export type BatchTextRun = {
  requestId: string;
  direction: McpTranslationBatchDirection;
  controller: AbortController;
  status: "running" | "completed" | "partial" | "failed" | "cancelled";
  failure?: unknown;
};
export type BatchTextCommit = (
  request: McpTranslationPatch,
  expected: {
    workId: string;
    membership: string;
    contextRevision: string | null;
  },
  guard: () => void,
  onCommitted: (page: MangaPage) => void,
) => Promise<void>;

/** A sequence of ordinary page edits, NOT a model queue or a chapter-wide lock.
 * Each committed page is acknowledged before renderer notifications can fail. */
export async function runMcpTranslationBatch(
  plan: BatchTextPlan,
  target: { chapterId: string; contextRevision: string },
  run: BatchTextRun,
  commit: BatchTextCommit,
  guard: () => void,
  touch: () => void,
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
      const edits = page.changes
        .filter((change) => change.changed)
        .map((change) => ({
          blockId: change.blockId,
          translatedText:
            run.direction === "undo"
              ? change.previousText
              : change.proposedText,
        }));
      await commit(
        {
          chapterId: target.chapterId,
          pageId: page.pageId,
          revision: page.expectedRevision as McpTranslationPatch["revision"],
          edits,
        },
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
