import type { JobEvent } from "../../shared/jobTypes";
import { jobControlIpcContracts } from "../../shared/ipcContracts";
import { emitJobEvent } from "../jobs/jobEvents";
import type { IpcContext } from "./context";
import { tMain } from "./localization";
import { trustedHandleContract } from "./trustedIpc";

type JobControlIpcContext = Pick<IpcContext, "getMainWindow" | "jobs">;

export function registerJobControlIpc(context: JobControlIpcContext): void {
  trustedHandleContract(context, jobControlIpcContracts.cancelJob, async () => {
    const job = context.jobs.current;
    if (!job) {
      return { cancelled: false };
    }

    const payload = {
      id: job.id,
      kind: job.kind,
      status: "cancelling",
      progressText: tMain("jobs.cancelling"),
      progressCurrent: job.lastEvent?.progressCurrent,
      progressTotal: job.lastEvent?.progressTotal,
      pageIndex: job.lastEvent?.pageIndex,
      pageTotal: job.lastEvent?.pageTotal,
      attempt: job.lastEvent?.attempt,
      attemptTotal: job.lastEvent?.attemptTotal,
    } satisfies JobEvent;
    emitJobEvent(context.jobs, context.getMainWindow(), payload);
    job.abortController.abort();
    await context.jobs.runCleanup(job, "cancel");
    return { cancelled: true };
  });
}
