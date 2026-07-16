import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { ERROR_REPORT_MAX_LOG_ENTRIES } from "../shared/errorReportTypes";

export type DiagnosticLogEntry = {
  source: "current" | "previous";
  line: string;
};

export async function readRecentDiagnosticLogEntries(
  previousLogPath: string,
  currentLogPath: string,
): Promise<DiagnosticLogEntry[]> {
  const entries: DiagnosticLogEntry[] = [];
  await appendDiagnosticLogEntries(entries, previousLogPath, "previous");
  await appendDiagnosticLogEntries(entries, currentLogPath, "current");
  return entries.slice(-ERROR_REPORT_MAX_LOG_ENTRIES);
}

async function appendDiagnosticLogEntries(
  entries: DiagnosticLogEntry[],
  logPath: string,
  source: DiagnosticLogEntry["source"],
): Promise<void> {
  const input = createReadStream(logPath, { encoding: "utf8" });
  const lines = createInterface({
    input,
    crlfDelay: Infinity,
  });
  try {
    for await (const rawLine of lines) {
      appendWarnOrErrorEntry(entries, source, rawLine.replace(/^\ufeff/, ""));
    }
  } catch (error) {
    appendLogReadFailure(entries, source, error);
  } finally {
    lines.close();
    input.destroy();
  }
}

function appendWarnOrErrorEntry(
  entries: DiagnosticLogEntry[],
  source: DiagnosticLogEntry["source"],
  line: string,
): void {
  if (!/\[(?:WARN|ERROR)\]/.test(line)) {
    return;
  }
  entries.push({ source, line });
  if (entries.length > ERROR_REPORT_MAX_LOG_ENTRIES) {
    entries.shift();
  }
}

function appendLogReadFailure(
  entries: DiagnosticLogEntry[],
  source: DiagnosticLogEntry["source"],
  error: unknown,
): void {
  if (isMissingFileError(error)) {
    return;
  }
  entries.push({
    source,
    line: `[diagnostic] Failed to read ${source} app log (${errorCode(error)}).`,
  });
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String(error.code);
  }
  return "UNKNOWN";
}
