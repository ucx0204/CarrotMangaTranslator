import { randomUUID } from "node:crypto";
import type {
  McpImportBatchRun,
  McpImportBatchPrepare,
} from "../../shared/mcpImportBatch";
import {
  McpImportPreviewReferenceSchema,
  type McpImportReceipt,
} from "../../shared/mcpLibraryImport";
import { McpEditError } from "./mcpEditPolicy";
import type { McpOperationContext } from "./mcpOperationService";
import type {
  McpImportBatchRecord,
  McpImportBatchRow,
} from "./mcpImportBatchState";

type Preview = ReturnType<typeof McpImportPreviewReferenceSchema.parse>;
export type McpImportBatchPorts = {
  now: () => number;
  repository: {
    prepare: (
      owner: string,
      input: McpImportBatchPrepare,
      guard: () => void,
    ) => Promise<McpImportBatchRecord>;
    load: (owner: string, id: string) => Promise<McpImportBatchRecord>;
    save: (
      record: McpImportBatchRecord,
      version: number,
      guard: () => void,
    ) => Promise<void>;
    discard: (
      owner: string,
      id: string,
      guard: () => void,
    ) => Promise<{ id: string; status: "discarded"; pageChanges: 0 }>;
  };
  scan: (
    owner: string,
    url: string,
    requestId: string,
    context: McpOperationContext,
  ) => Promise<Record<string, unknown>>;
  previewStatus: (
    owner: string,
    preview: Preview,
    guard: () => void,
  ) => Promise<"ready" | "checking" | "importing" | "imported" | "unavailable">;
  receipt: (
    owner: string,
    previewId: string,
    guard: () => void,
  ) => Promise<McpImportReceipt | undefined>;
  cancelJob: (id: string, owner: string) => Promise<unknown>;
  reportError: (error: unknown) => void;
};
export type McpImportBatchActive = {
  jobId: string;
  id: string;
  owner: string;
  controller: AbortController;
  pause: boolean;
  done: Promise<unknown>;
  record?: McpImportBatchRecord;
};

export async function checkpointImportBatch(
  port: McpImportBatchPorts,
  record: McpImportBatchRecord,
  guard: () => void = () => {},
) {
  const next = structuredClone(record);
  next.version++;
  await port.repository.save(next, record.version, guard);
  record.version = next.version;
}

export async function retainedImportReceipt(
  port: McpImportBatchPorts,
  owner: string,
  row: McpImportBatchRow,
  guard: () => void,
) {
  if (row.receipt) return row.receipt;
  for (const attempt of row.attempts) {
    if (!attempt.preview) continue;
    const receipt = await port.receipt(owner, attempt.preview.previewId, guard);
    if (receipt) return receipt;
  }
  return undefined;
}

/** Existing app job owns admission, cancellation and native activity. No second queue. */
export async function executeImportBatch(
  port: McpImportBatchPorts,
  record: McpImportBatchRecord,
  active: McpImportBatchActive,
  input: McpImportBatchRun,
  context: McpOperationContext,
) {
  try {
    for (const row of record.items) {
      context.assertAuthorized();
      if (active.pause) break;
      const receipt = await retainedImportReceipt(
        port,
        record.owner,
        row,
        context.assertAuthorized,
      );
      if (receipt) {
        row.receipt = receipt;
        await checkpointImportBatch(port, record);
        continue;
      }
      if (!shouldScan(row, input)) continue;
      const previous = row.attempts.at(-1)?.preview;
      if (
        previous &&
        (await port.previewStatus(
          record.owner,
          previous,
          context.assertAuthorized,
        )) !== "unavailable"
      )
        continue;
      await scanItem(port, record, row, context);
      if (row.attempts.at(-1)?.errorCode === "editor_busy") break;
    }
    context.assertAuthorized();
    record.status = finalStatus(record, active.pause);
    record.errorCode = null;
    await checkpointImportBatch(port, record);
  } catch (error) {
    await recordImportFailure(port, record, context, error);
    throw error;
  }
}
function shouldScan(row: McpImportBatchRow, input: McpImportBatchRun) {
  const latest = row.attempts.at(-1);
  if (!latest) return true;
  return latest.status === "ready"
    ? input.rescanExpiredItemIds.includes(row.target.id)
    : input.retryItemIds.includes(row.target.id);
}
async function scanItem(
  port: McpImportBatchPorts,
  record: McpImportBatchRecord,
  row: McpImportBatchRow,
  context: McpOperationContext,
) {
  if (
    record.items.reduce((sum, item) => sum + item.attempts.length, 0) >=
    record.input.maxAttempts
  )
    throw new McpEditError(
      "invalid_edit",
      "Import scan attempt budget exhausted; no new network request started.",
    );
  const attempt: McpImportBatchRow["attempts"][number] = {
    requestId: randomUUID(),
    status: "scanning",
    preview: null,
    errorCode: null,
  };
  row.attempts.push(attempt);
  await checkpointImportBatch(port, record, context.assertAuthorized);
  context.progress({
    phase: "import-batch-scanning",
    completed: record.items.indexOf(row),
    total: record.items.length,
  });
  try {
    const result = await port.scan(
      record.owner,
      row.target.url,
      attempt.requestId,
      context,
    );
    context.assertAuthorized();
    attempt.preview = McpImportPreviewReferenceSchema.parse(
      result.importPreview,
    );
    attempt.status = "ready";
  } catch (error) {
    port.reportError(error);
    attempt.status = context.signal.aborted ? "cancelled" : "failed";
    attempt.errorCode =
      error instanceof McpEditError ? error.code : "import_scan_failed";
  }
  await checkpointImportBatch(port, record);
  context.assertAuthorized();
}
function finalStatus(
  record: McpImportBatchRecord,
  paused: boolean,
): McpImportBatchRecord["status"] {
  if (paused) return "paused";
  if (record.items.every((item) => item.receipt)) return "completed";
  return record.items.every(
    (item) => item.receipt || item.attempts.at(-1)?.status === "ready",
  )
    ? "review_required"
    : "partial";
}

async function recordImportFailure(
  port: McpImportBatchPorts,
  record: McpImportBatchRecord,
  context: McpOperationContext,
  error: unknown,
) {
  record.status = context.signal.aborted ? "cancelled" : "failed";
  record.errorCode =
    error instanceof McpEditError ? error.code : "import_batch_failed";
  port.reportError(error);
  // Only checkpoint already-admitted progress; never publish a chapter or start a scan here.
  await checkpointImportBatch(port, record).catch((saveError) => {
    throw new AggregateError(
      [error, saveError],
      "Import batch final checkpoint failed.",
    );
  });
}
