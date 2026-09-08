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
  trustedHandleContract(
    context,
    jobControlIpcContracts.cancelJob,
    async (
      _event,
      request?: { reason?: "codex-disconnected"; jobId: string },
    ) => {
      const job = context.jobs.current;
      if (!job || !canCancelJob(job, request)) return { cancelled: false };

      const disconnected = request?.reason === "codex-disconnected";
      const last: Partial<JobEvent> = job.lastEvent ?? {};
      const payload = {
        id: job.id,
        kind: job.kind,
        status: disconnected ? "failed" : "cancelling",
        phase: disconnected ? "failed" : undefined,
        detail: disconnected
          ? "Codex 연결이 끊겼습니다. 연결 후 다시 실행해 주세요."
          : undefined,
        progressText: tMain(disconnected ? "jobs.failed" : "jobs.cancelling"),
        progressCurrent: last.progressCurrent,
        progressTotal: last.progressTotal,
        pageIndex: last.pageIndex,
        pageTotal: last.pageTotal,
        attempt: last.attempt,
        attemptTotal: last.attemptTotal,
      } satisfies JobEvent;
      emitJobEvent(context.jobs, context.getMainWindow(), payload);
      job.abortController.abort(
        disconnected
          ? Object.assign(
              new Error("Codex 연결이 끊겼습니다. 연결 후 다시 실행해 주세요."),
              { code: "CODEX_DISCONNECTED" },
            )
          : undefined,
      );
      await context.jobs.runCleanup(job, "cancel");
      return { cancelled: true };
    },
  );

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

function canCancelJob(
  job: NonNullable<JobControlIpcContext["jobs"]["current"]>,
  request?: { jobId: string },
): boolean {
  if (
    ["completed", "failed", "cancelled"].includes(job.lastEvent?.status ?? "")
  )
    return false;
  return (
    !request ||
    (job.id === request.jobId &&
      (job.kind === "gemma-analysis" ||
        job.kind === "sound-effect-translation"))
  );
}
