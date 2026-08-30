import type { JobEvent } from "../../shared/jobTypes";
import { jobControlIpcContracts } from "../../shared/ipcContracts";
import { FinishPageTimingSessionRequestSchema } from "../../shared/ipcPageTimingSchemas";
import { parseIpcPayload } from "../../shared/ipcSchemas";
import { emitJobEvent } from "../jobs/jobEvents";
import type { IpcContext } from "./context";
import { tMain } from "./localization";
import { trustedHandleContract } from "./trustedIpc";
import { pageTimingSessionManager } from "../jobs/pageTimingSessionManager";

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

  trustedHandleContract(
    context,
    jobControlIpcContracts.finishPageTimingSession,
    async (_event, rawRequest: unknown) =>
      pageTimingSessionManager.finish(
        parseIpcPayload(
          FinishPageTimingSessionRequestSchema,
          rawRequest,
          "페이지 소요 시간 정산",
        ),
      ),
  );
}
