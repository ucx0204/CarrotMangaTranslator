import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { startInpaintingJob } from "../jobs/inpaintingJobs";
import {
  productionInpaintingJobRuntime,
  type InpaintingJobRuntime,
} from "../jobs/inpaintingJobRuntime";
import { createPageRevision } from "../../shared/pageRevision";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpOperationContext } from "../application/mcpOperationService";
import type { McpOperationTarget } from "./mcpOperationTools";

type Editing = {
  assertWritable: (chapterId: string, pageId: string) => Promise<void>;
  assertClean: (chapterId: string, pageId: string) => Promise<void>;
  notifySaved: (chapterId: string, pageId: string) => void;
};
/** No alternate removal implementation: execute the existing page-pattern job,
 * including mask selection, engine leases, history and optimistic image commits. */
export async function eraseMcpPage(
  app: InpaintingJobContext,
  editing: Editing,
  target: McpOperationTarget,
  operation: McpOperationContext,
  runtime: InpaintingJobRuntime = productionInpaintingJobRuntime,
) {
  operation.assertAuthorized();
  const settings = await runtime.getSettings(app.appPaths);
  const scopedApp = {
    ...app,
    executionSettings: settings,
    retainPageOwnership: true,
  };
  operation.assertAuthorized();
  const guarded = guardErasureRuntime(runtime, editing, target, operation);
  const previous = app.jobs.current;
  const pending = startInpaintingJob(
    scopedApp,
    {
      mode: "page-pattern",
      chapterId: target.chapterId,
      pageId: target.pageId,
      blockId: target.blockId,
      postprocess: { bubbleLayout: { enabled: false, policy: "safe" } },
    },
    { ...guarded, getSettings: async () => settings },
  );
  const job = app.jobs.current !== previous ? app.jobs.current : null;
  const cancel = () => {
    if (job && app.jobs.current === job) job.abortController.abort();
  };
  operation.signal.addEventListener("abort", cancel, { once: true });
  if (operation.signal.aborted) cancel();
  try {
    const result = await pending;
    if (result.status === "failed")
      throw new Error("App erasure failed; see local job details.");
    const page = result.chapter?.pages.find(
      (entry) => entry.id === target.pageId,
    );
    if (page) editing.notifySaved(target.chapterId, target.pageId);
    return {
      status: result.status,
      chapterId: target.chapterId,
      pageId: target.pageId,
      blockId: target.blockId,
      revision: page ? createPageRevision(page) : target.revision,
      pagesChanged: result.pagesChanged ?? 0,
      blocksErased: result.blocksErased ?? 0,
      blocksIncomplete: result.blocksIncomplete ?? 0,
      performed: ["erase-original"],
      engine: "app-configured-local",
    };
  } finally {
    operation.signal.removeEventListener("abort", cancel);
  }
}
function guardErasureRuntime(
  runtime: InpaintingJobRuntime,
  editing: Editing,
  target: McpOperationTarget,
  operation: McpOperationContext,
): InpaintingJobRuntime {
  return {
    ...runtime,
    openChapter: async (chapterId) => {
      operation.assertAuthorized();
      const chapter = await runtime.openChapter(chapterId);
      const page = chapter.pages.find((entry) => entry.id === target.pageId);
      if (
        chapterId !== target.chapterId ||
        !page ||
        createPageRevision(page) !== target.revision
      )
        throw new McpEditError(
          "revision_conflict",
          "Read the current page before erasing.",
        );
      if (target.blockId !== undefined) {
        const block = page.blocks.find((entry) => entry.id === target.blockId);
        if (!block)
          throw new McpEditError(
            "not_found",
            "The selected erasure block no longer exists. Read the page again.",
          );
        if (block.inpaintExcluded)
          throw new McpEditError(
            "invalid_edit",
            "The selected block is excluded from erasure. Change that setting explicitly before retrying.",
          );
      }
      return chapter;
    },
    savePages: async (chapterId, pages, options) => {
      operation.assertAuthorized();
      if (
        chapterId !== target.chapterId ||
        pages.some((page) => page.id !== target.pageId)
      )
        throw new McpEditError("invalid_edit", "Unexpected erasure target.");
      await editing.assertClean(chapterId, target.pageId);
      return runtime.savePages(
        chapterId,
        pages,
        options,
        operation.assertAuthorized,
      );
    },
    emitEvent: (jobs, window, event) => {
      runtime.emitEvent(jobs, window, event);
      operation.progress({
        phase: event.phase ?? event.status,
        completed: event.progressCurrent,
        total: event.progressTotal,
      });
    },
  };
}
