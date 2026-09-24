import { randomUUID } from "node:crypto";
import type { z } from "zod/v4";
import type {
  McpResearchBatchAttemptSchema,
  McpResearchBatchRun,
} from "../../shared/mcpResearchBatch";
import { McpEditError } from "./mcpEditPolicy";
import {
  researchWorkComplete,
  type McpResearchBatchRecord,
  type McpResearchBatchRow,
} from "./mcpResearchBatchPolicy";

type Attempt = z.infer<typeof McpResearchBatchAttemptSchema>;
export type McpResearchBatchRuntime = {
  assertReady: () => void;
  execute: (
    row: McpResearchBatchRow,
    attempt: Attempt,
    signal: AbortSignal,
    onJob: (id: string) => Promise<void>,
  ) => Promise<Attempt>;
  reconcile: (
    row: McpResearchBatchRow,
    attempt: Attempt,
  ) => Promise<Attempt | undefined>;
};
export type McpResearchBatchActive = {
  record: McpResearchBatchRecord;
  controller: AbortController;
  pause: boolean;
  done: Promise<void>;
};
export type McpResearchBatchRunnerPort = {
  now: () => number;
  save: (
    record: McpResearchBatchRecord,
    previousVersion: number,
    guard: () => void,
  ) => Promise<void>;
  open: (
    record: McpResearchBatchRecord,
    input: McpResearchBatchRun,
    guard: () => void,
  ) => Promise<McpResearchBatchRuntime>;
  reportError: (error: unknown) => void;
};
export async function saveResearchCheckpoint(
  port: Pick<McpResearchBatchRunnerPort, "save">,
  record: McpResearchBatchRecord,
  guard: () => void = () => {},
) {
  const next = structuredClone(record);
  next.version++;
  await port.save(next, record.version, guard);
  record.version = next.version;
}

/** Orders existing app operations, not models. Every child settles before another starts. */
export async function runResearchBatch(
  port: McpResearchBatchRunnerPort,
  active: McpResearchBatchActive,
  input: McpResearchBatchRun,
  authorize: () => void,
) {
  const record = active.record;
  const guard = () => {
    active.controller.signal.throwIfAborted();
    authorize();
    if (record.expiresAt <= port.now())
      throw new McpEditError("not_found", "Research plan retention expired.");
  };
  try {
    guard();
    record.errorCode = null;
    const runtime = await port.open(record, input, guard);
    for (const row of record.works) {
      guard();
      if (active.pause) {
        record.status = "paused";
        break;
      }
      if (row.status === "held" || researchWorkComplete(row)) continue;
      runtime.assertReady();
      await runResearchWork(
        port,
        active,
        row,
        runtime,
        input.retryFailed,
        guard,
      );
      runtime.assertReady();
    }
    guard();
    if (record.status === "running")
      record.status = record.works.every(researchWorkComplete)
        ? "completed"
        : "partial";
    await saveResearchCheckpoint(port, record);
  } catch (error) {
    record.status = active.controller.signal.aborted ? "cancelled" : "failed";
    record.errorCode =
      error instanceof McpEditError ? error.code : "research_batch_failed";
    port.reportError(error);
    // Preserve progress of already-admitted work, even after caller revocation.
    // This does not publish context or admit another model request.
    await saveResearchCheckpoint(port, record);
  }
}
async function runResearchWork(
  port: McpResearchBatchRunnerPort,
  active: McpResearchBatchActive,
  row: McpResearchBatchRow,
  runtime: McpResearchBatchRuntime,
  retryFailed: boolean,
  guard: () => void,
) {
  const previous = row.attempts.at(-1);
  if (previous) {
    const recovered = await runtime.reconcile(row, previous);
    if (recovered) {
      Object.assign(previous, recovered);
      row.status = recovered.status;
      await saveResearchCheckpoint(port, active.record);
      if (researchWorkComplete(row)) return;
    }
    if (previous.status === "running") {
      previous.status = "interrupted";
      previous.errorCode = "explicit_retry_required";
      row.status = "interrupted";
      await saveResearchCheckpoint(port, active.record);
    }
    if (!retryFailed) return;
  }
  if (
    active.record.works.reduce((sum, work) => sum + work.attempts.length, 0) >=
    active.record.input.maxAttempts
  )
    throw new McpEditError(
      "invalid_edit",
      "Research attempt budget exhausted; no new call was started.",
    );
  guard();
  const attempt: Attempt = {
    requestId: randomUUID(),
    jobId: null,
    status: "running",
    proposalId: null,
    usage: null,
    errorCode: null,
  };
  row.attempts.push(attempt);
  row.status = "running";
  await saveResearchCheckpoint(port, active.record, guard);
  const result = await runtime.execute(
    row,
    attempt,
    active.controller.signal,
    async (id) => {
      attempt.jobId = id;
      await saveResearchCheckpoint(port, active.record);
    },
  );
  Object.assign(attempt, result);
  row.status = result.status;
  await saveResearchCheckpoint(port, active.record);
}
