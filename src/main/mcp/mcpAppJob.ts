import type { ChapterSnapshot } from "../../shared/libraryTypes";
import type { AppActivityResource } from "../../shared/appActivityTypes";
import { reserveJobChapter, acquireJobPage } from "../jobs/jobPageOwnership";
import type { JobEvent } from "../../shared/jobTypes";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { emitJobEvent } from "../jobs/jobEvents";
import type { McpOperationContext } from "../application/mcpOperationService";
import { McpEditError } from "../application/mcpEditPolicy";

type McpAppJobScope = {
  resources: readonly AppActivityResource[];
  page?: {
    chapterId: string;
    pageId: string;
    readChapter: (id: string) => Promise<ChapterSnapshot>;
  };
};

/** Uses the application's real exclusive activity lease and cancel/quit lifecycle. */
export async function runMcpAppJob<T>(
  app: InpaintingJobContext,
  operation: McpOperationContext,
  kind: "gemma-analysis" | "page-export" | "mcp-edit",
  execute: (
    context: McpOperationContext,
    emit: (event: JobEvent) => void,
  ) => Promise<T>,
  scope?: McpAppJobScope,
): Promise<T> {
  operation.assertAuthorized();
  if (!scope && app.jobs.hasActive)
    throw new McpEditError("editor_busy", "Another app operation is running.");
  const controller = new AbortController();
  const signal = AbortSignal.any([operation.signal, controller.signal]);
  const cancel = () => controller.abort(operation.signal.reason);
  let finished!: () => void;
  const completion = new Promise<void>((resolve) => {
    finished = resolve;
  });
  app.jobs.start({
    id: operation.id,
    kind,
    resources: scope?.resources,
    abortController: controller,
    cleanup: () => completion,
  });
  operation.signal.addEventListener("abort", cancel, { once: true });
  if (operation.signal.aborted) cancel();
  const emit = (event: JobEvent) => {
    emitJobEvent(app.jobs, app.getMainWindow(), event);
    operation.progress({
      phase: event.phase ?? event.status,
      completed: event.progressCurrent,
      total: event.progressTotal,
    });
  };
  const context = {
    ...operation,
    signal,
    assertAuthorized: () => {
      signal.throwIfAborted();
      operation.assertAuthorized();
    },
  };
  try {
    context.assertAuthorized();
    emitStatus(emit, operation.id, kind, "running");
    const result = await app.jobs.run(operation.id, async () => {
      if (scope?.page) await preparePage(app, context, scope.page);
      return execute(context, emit);
    });
    emitStatus(emit, operation.id, kind, "completed");
    return result;
  } catch (error) {
    const status = signal.aborted ? "cancelled" : "failed";
    emitStatus(emit, operation.id, kind, status);
    throw error;
  } finally {
    operation.signal.removeEventListener("abort", cancel);
    app.jobs.clearIfCurrent(operation.id);
    finished();
  }
}

async function preparePage(
  app: InpaintingJobContext,
  context: McpOperationContext,
  target: NonNullable<McpAppJobScope["page"]>,
): Promise<void> {
  const chapter = await target.readChapter(target.chapterId);
  context.assertAuthorized();
  if (
    chapter.id !== target.chapterId ||
    !chapter.pages.some((page) => page.id === target.pageId)
  )
    throw new McpEditError("not_found", "Page not found.");
  reserveJobChapter(app.jobs, context.id, chapter, [target.pageId]);
  await acquireJobPage(
    app.jobs,
    context.id,
    target.chapterId,
    target.pageId,
    target.readChapter,
  );
  context.assertAuthorized();
}

function emitStatus(
  emit: (event: JobEvent) => void,
  id: string,
  kind: JobEvent["kind"],
  status: "running" | "completed" | "cancelled" | "failed",
): void {
  emit({
    id,
    kind,
    status,
    phase:
      status === "running"
        ? "finalizing"
        : status === "completed"
          ? "done"
          : status,
    progressText:
      status === "running"
        ? "MCP 페이지 작업"
        : status === "completed"
          ? "MCP 페이지 작업 완료"
          : "MCP 페이지 작업 중단",
  });
}
