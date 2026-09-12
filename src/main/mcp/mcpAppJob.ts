import type { JobEvent } from "../../shared/jobTypes";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import { emitJobEvent } from "../jobs/jobEvents";
import type { McpOperationContext } from "../application/mcpOperationService";
import { McpEditError } from "../application/mcpEditPolicy";

/** Uses the application's real exclusive activity lease and cancel/quit lifecycle. */
export async function runMcpAppJob<T>(
  app: InpaintingJobContext,
  operation: McpOperationContext,
  kind: "gemma-analysis" | "page-export",
  execute: (
    context: McpOperationContext,
    emit: (event: JobEvent) => void,
  ) => Promise<T>,
): Promise<T> {
  operation.assertAuthorized();
  if (app.jobs.hasActive)
    throw new McpEditError("editor_busy", "Another app operation is running.");
  const controller = new AbortController();
  const signal = AbortSignal.any([operation.signal, controller.signal]);
  let finished!: () => void;
  const completion = new Promise<void>((resolve) => {
    finished = resolve;
  });
  app.jobs.start({
    id: operation.id,
    kind,
    abortController: controller,
    cleanup: () => completion,
  });
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
    emit({
      id: operation.id,
      kind,
      status: "running",
      phase: "ready",
      progressText: "MCP 페이지 작업",
    });
    const result = await execute(context, emit);
    emit({
      id: operation.id,
      kind,
      status: "completed",
      phase: "done",
      progressText: "MCP 페이지 작업 완료",
    });
    return result;
  } catch (error) {
    const status = signal.aborted ? "cancelled" : "failed";
    emit({
      id: operation.id,
      kind,
      status,
      phase: status,
      progressText: "MCP 페이지 작업 중단",
    });
    throw error;
  } finally {
    app.jobs.clearIfCurrent(operation.id);
    finished();
  }
}
