import { McpEditError } from "./mcpEditPolicy";
import { mcpJobTargetSchema } from "./mcpJobJournal";
import { publicMcpJobResult, mcpPersistedTargetSchema } from "./mcpJobJournal";
import type { McpStoredJob } from "./mcpJobJournal";

export type McpOperationEntry = Omit<
  McpStoredJob,
  "parameters" | "kind" | "result"
> & {
  parameters: unknown;
  kind: string;
  result?: Record<string, unknown>;
  settled: boolean;
  controller: AbortController;
  done: Promise<void>;
};

/** Ephemeral services retain their original in-memory inputs, without disk serialization. */
export function memoryMcpOperationRecord(
  entry: McpOperationEntry,
): McpStoredJob {
  const {
    controller: _controller,
    done: _done,
    settled: _settled,
    ...record
  } = entry;
  return structuredClone(record) as McpStoredJob;
}

export function restoreMcpOperationEntry(
  record: McpStoredJob,
  now: number,
): McpOperationEntry {
  const interrupted = record.status === "running";
  const result = record.result ? { ...record.result } : undefined;
  if (
    result &&
    [
      "rendered-page-png",
      "rendered-pages-png",
      "rendered-pages-images",
      "rendered-pages-zip",
      "native-work-file",
      "exchange-file",
    ].includes(String(result.kind))
  )
    Object.assign(result, { artifactExpired: true });
  return {
    ...record,
    result,
    status: interrupted ? "interrupted" : record.status,
    progress: interrupted ? { phase: "interrupted" } : record.progress,
    finishedAt: interrupted ? now : record.finishedAt,
    error: interrupted
      ? {
          code: "interrupted",
          message:
            "The server stopped before final receipt commit. Inspect the saved page before an explicit retry.",
        }
      : record.error,
    controller: new AbortController(),
    settled: true,
    done: Promise.resolve(),
  };
}

export function projectMcpOperation(
  entry: McpOperationEntry,
  now: number,
  durable: boolean,
) {
  return structuredClone({
    jobId: entry.id,
    requestId: entry.requestId,
    kind: entry.kind,
    status: entry.settled ? entry.status : "running",
    cancellationRequested:
      entry.cancellationRequested || entry.controller.signal.aborted,
    progress:
      !entry.settled && entry.status !== "running"
        ? { phase: "saving_receipt" }
        : entry.progress,
    result: entry.settled ? publicMcpJobResult(entry.result, now) : undefined,
    error: entry.settled ? entry.error : undefined,
    startedAt: entry.startedAt,
    finishedAt: entry.settled ? entry.finishedAt : undefined,
    target: mcpPersistedTargetSchema.safeParse(entry.parameters).data,
    persistence: durable ? "durable" : "memory",
  });
}

export function mcpRetryTarget(entry: McpOperationEntry, revision: string) {
  if (
    !entry.settled ||
    !["failed", "cancelled", "interrupted"].includes(entry.status)
  )
    throw new McpEditError(
      "invalid_edit",
      "Only failed, cancelled or interrupted jobs can be retried.",
    );
  if (
    ![
      "ocr",
      "blockOcr",
      "sourceSize",
      "blockTranslation",
      "erase",
      "exportPng",
    ].includes(entry.kind)
  )
    throw new McpEditError(
      "invalid_edit",
      "Read current context, typography preflight, import receipts, discovery or export outcomes and issue a new explicit request; single-page retry does not apply to these jobs.",
    );
  const target = mcpJobTargetSchema.parse(entry.parameters);
  if (target.revision !== revision)
    throw new McpEditError(
      "revision_conflict",
      "The original target revision is required. Inspect the current page; changed pages need a new explicit operation.",
    );
  return { kind: entry.kind, target: { ...target } };
}
