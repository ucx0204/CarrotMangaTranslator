import { ipcMain } from "electron";
import type { JobEvent } from "../../shared/types";
import type { IpcContext } from "./context";

export function registerJobControlIpc(context: IpcContext): void {
  ipcMain.handle("job:cancel", async () => {
    const job = context.jobs.current;
    if (!job) {
      return { cancelled: false };
    }

    context.getMainWindow()?.webContents.send("job:event", {
      id: job.id,
      kind: job.kind,
      status: "cancelling",
      progressText: "작업 취소 중",
      progressCurrent: job.lastEvent?.progressCurrent,
      progressTotal: job.lastEvent?.progressTotal,
      pageIndex: job.lastEvent?.pageIndex,
      pageTotal: job.lastEvent?.pageTotal,
      attempt: job.lastEvent?.attempt,
      attemptTotal: job.lastEvent?.attemptTotal
    } satisfies JobEvent);
    job.abortController.abort();
    await context.jobs.runCleanup(job, "cancel");
    return { cancelled: true };
  });
}
