import {
  parseMcpJobJournal,
  persistedMcpJobResult,
  type McpStoredJob,
} from "./mcpJobJournal";
type SnapshotEntry = Omit<McpStoredJob, "parameters" | "kind" | "result"> & {
  parameters: unknown;
  kind: string;
  result?: Record<string, unknown>;
  controller: AbortController;
};

export function snapshotMcpEntries(entries: Iterable<SnapshotEntry>) {
  const records = [...entries].map((entry) => ({
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
  }));
  return { version: 1, records: parseMcpJobJournal({ version: 1, records }) };
}
