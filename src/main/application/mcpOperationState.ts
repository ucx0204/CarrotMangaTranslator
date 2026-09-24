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
