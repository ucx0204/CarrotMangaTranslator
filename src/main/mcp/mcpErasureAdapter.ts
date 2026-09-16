import type { MangaPage } from "../../shared/libraryTypes";
import { modelCleanupIsBlocked } from "../runtimeSupport/modelCleanupBarrier";
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
/** Reuse the native job, page ownership, masks, history and transaction guards. */
export async function eraseMcpPage(
  app: InpaintingJobContext,
  editing: Editing,
  target: McpOperationTarget,
  operation: McpOperationContext,
  runtime: InpaintingJobRuntime = productionInpaintingJobRuntime,
) {
  operation.assertAuthorized();
  const settings = await runtime.getSettings(app.appPaths);
  const scopedApp = { ...app, executionSettings: settings, retainPageOwnership: true };
  operation.assertAuthorized();
  let committedPage: MangaPage | undefined;
  const guarded = guardErasureRuntime(runtime, editing, target, operation, (page) => { committedPage = page; });
  const previous = new Set(app.jobs.all.map((job) => job.id));
  const pending = startInpaintingJob(
    scopedApp,
    {
      mode: "page-pattern", chapterId: target.chapterId, pageId: target.pageId,
      blockId: target.blockId,
      postprocess: { bubbleLayout: { enabled: false, policy: "safe" } },
    },
    { ...guarded, getSettings: async () => settings },
  );
  const job = app.jobs.all.find((entry) => !previous.has(entry.id) && entry.kind === "inpainting");
  const cancel = () => {
    if (job && app.jobs.get(job.id) === job) job.abortController.abort();
  };
  operation.signal.addEventListener("abort", cancel, { once: true });
  if (operation.signal.aborted) cancel();
  try {
    const result = await pending;
    if (result.status === "failed") throw new Error("App erasure failed; see local job details.");
    const page = result.chapter?.pages.find((entry) => entry.id === target.pageId);
    if (page) editing.notifySaved(target.chapterId, target.pageId);
    return {
      status: result.status, chapterId: target.chapterId, pageId: target.pageId,
      blockId: target.blockId, revision: page ? createPageRevision(page) : target.revision,
      pagesChanged: result.pagesChanged ?? 0, blocksErased: result.blocksErased ?? 0,
      blocksIncomplete: result.blocksIncomplete ?? 0,
      performed: ["erase-original"], engine: "app-configured-local",
    };
  } catch (error) {
    return cleanupFailure(error, committedPage, target, editing, runtime);
  } finally {
    operation.signal.removeEventListener("abort", cancel);
  }
}
function guardErasureRuntime(
  runtime: InpaintingJobRuntime, editing: Editing, target: McpOperationTarget,
  operation: McpOperationContext, onSaved: (page: MangaPage) => void,
): InpaintingJobRuntime {
  return {
    ...runtime,
    acquireEngine: async (options) => {
      const lease = await runtime.acquireEngine(options);
      return { ...lease, release: async () => {
        operation.progress({ phase: "releasing_model" });
        await lease.release();
      } };
    },
    openChapter: async (chapterId) => {
      operation.assertAuthorized();
      const chapter = await runtime.openChapter(chapterId);
      const page = chapter.pages.find((entry) => entry.id === target.pageId);
      if (chapterId !== target.chapterId || !page || createPageRevision(page) !== target.revision)
        throw new McpEditError("revision_conflict", "Read the current page before erasing.");
      if (target.blockId !== undefined) {
        const block = page.blocks.find((entry) => entry.id === target.blockId);
        if (!block) throw new McpEditError("not_found", "The selected erasure block no longer exists. Read the page again.");
        if (block.inpaintExcluded) throw new McpEditError("invalid_edit", "The selected block is excluded from erasure. Change that setting explicitly before retrying.");
      }
      return chapter;
    },
    savePages: async (chapterId, pages, options) => {
      operation.assertAuthorized();
      if (chapterId !== target.chapterId || pages.some((page) => page.id !== target.pageId))
        throw new McpEditError("invalid_edit", "Unexpected erasure target.");
      await editing.assertClean(chapterId, target.pageId);
      const saved = await runtime.savePages(chapterId, pages, options, operation.assertAuthorized);
      const page = saved.pages.find((entry) => entry.id === target.pageId);
      if (page) onSaved(page);
      return saved;
    },
    emitEvent: (jobs, window, event) => {
      runtime.emitEvent(jobs, window, event);
      operation.progress({ phase: event.phase ?? event.status, completed: event.progressCurrent, total: event.progressTotal });
    },
  };
}
function cleanupFailure(
  error: unknown, page: MangaPage | undefined, target: McpOperationTarget,
  editing: Editing, runtime: InpaintingJobRuntime,
) {
  if (!modelCleanupIsBlocked()) throw error;
  if (!page) throw new McpEditError("editor_busy", "Local model cleanup is incomplete. New model work is blocked; inspect the local log before retrying.", { cause: error });
  runtime.logError("MCP page saved but native model cleanup failed", { error });
  editing.notifySaved(target.chapterId, target.pageId);
  return {
    status: "partial" as const, cleanupFailed: true,
    chapterId: target.chapterId, pageId: target.pageId, blockId: target.blockId,
    revision: createPageRevision(page), pagesChanged: 1,
    blocksErased: undefined, blocksIncomplete: undefined,
    performed: ["erase-original"], engine: "app-configured-local",
  };
}
