import { MCP_JOB_RETENTION_MS, type McpStoredJob } from "./mcpJobJournal";

/** Small authoritative identity; large targets and results never enter the index. */
export type McpJobSummary = Omit<
  McpStoredJob,
  "compacted" | "parameters" | "result" | "progress" | "error"
> & { revision: number; expiresAt?: number };

export type McpJobPersistence = {
  open: () => Promise<McpJobSummary[]>;
  read: (id: string) => Promise<McpStoredJob>;
  save: (
    record: McpStoredJob,
    expectedRevision: number | null,
  ) => Promise<McpJobSummary>;
  update: (
    id: string,
    expectedRevision: number,
    changes: Pick<
      McpJobSummary,
      "status" | "cancellationRequested" | "finishedAt" | "expiresAt"
    >,
  ) => Promise<McpJobSummary>;
  remove: (id: string, expectedRevision: number, now: number) => Promise<void>;
  cleanup: (now: number) => Promise<void>;
};

export function summarizeMcpJob(
  record: McpStoredJob,
  revision: number,
): McpJobSummary {
  const {
    parameters: _parameters,
    result: _result,
    progress: _progress,
    error: _error,
    compacted: _compacted,
    ...identity
  } = record;
  return {
    ...identity,
    revision,
    ...(record.finishedAt === undefined
      ? {}
      : { expiresAt: record.finishedAt + MCP_JOB_RETENTION_MS }),
  };
}
