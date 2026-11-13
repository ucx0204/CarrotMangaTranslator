import {
  parseMcpStoredJob,
  persistedMcpJobResult,
  type McpStoredJob,
} from "./mcpJobJournal";
type SnapshotEntry = Omit<McpStoredJob, "parameters" | "kind" | "result"> & {
  parameters: unknown;
  kind: string;
  result?: Record<string, unknown>;
  controller: AbortController;
};

export function snapshotMcpEntry(entry: SnapshotEntry): McpStoredJob {
  return parseMcpStoredJob({
    ...(entry.compacted ? { compacted: entry.compacted } : {}),
    id: entry.id,
    owner: entry.owner,
    requestId: entry.requestId,
    fingerprint: entry.fingerprint,
    kind: entry.kind,
    parameters: entry.parameters,
    status: entry.status,
    progress: entry.progress,
    result: persistedMcpJobResult(entry.result),
    error: entry.error,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    cancellationRequested:
      entry.cancellationRequested || entry.controller.signal.aborted,
  });
}
