import type { BrowserWindow } from "electron";
import { ipcEventContracts } from "../../shared/ipcContracts";
import type { JobEvent } from "../../shared/jobTypes";
import { writeLog } from "../logger";
import type { ActiveJobStore } from "./activeJob";

export function emitJobEvent(
  jobs: ActiveJobStore,
  mainWindow: BrowserWindow | null,
  event: JobEvent,
): void {
  jobs.updateLastEvent(event.id, event);
  writeLog(
    event.status === "failed"
      ? "error"
      : event.status === "cancelled"
        ? "warn"
        : "info",
    `job:${event.kind}:${event.status}`,
    {
      id: event.id,
      progressText: event.progressText,
      phase: event.phase,
      progressCurrent: event.progressCurrent,
      progressTotal: event.progressTotal,
      progressMode: event.progressMode,
      progressPercent: event.progressPercent,
      progressBytes: event.progressBytes,
      progressTotalBytes: event.progressTotalBytes,
      progressBytesPerSecond: event.progressBytesPerSecond,
      installLogLine: event.installLogLine,
      pageIndex: event.pageIndex,
      pageTotal: event.pageTotal,
      attempt: event.attempt,
      attemptTotal: event.attemptTotal,
      detail: event.detail,
    },
  );
  mainWindow?.webContents.send(
    ipcEventContracts.jobEvent.channel,
    ipcEventContracts.jobEvent.payload.parse(event),
  );
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
