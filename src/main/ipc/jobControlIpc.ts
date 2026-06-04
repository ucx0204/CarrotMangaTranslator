import type { JobEvent } from "../../shared/types";
import type { IpcContext } from "./context";
import { trustedHandle } from "./trustedIpc";

export function registerJobControlIpc(context: IpcContext): void {
  trustedHandle(context, "job:cancel", async () => {
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
