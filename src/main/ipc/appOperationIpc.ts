import { appOperationIpcContracts } from "../../shared/ipcAppOperationContracts";
import { ipcEventContracts } from "../../shared/ipcEventContracts";
import type { IpcContext } from "./context";
import { trustedHandleContract } from "./trustedIpc";

type AppOperationIpcContext = Pick<
  IpcContext,
  "getMainWindow" | "operations" | "jobs"
>;

export function registerAppOperationIpc(context: AppOperationIpcContext): void {
  registerActivityStateIpc(context);
  trustedHandleContract(
    context,
    appOperationIpcContracts.getActiveJobs,
    async () =>
      context.jobs.all.map(
        (job) =>
          job.lastEvent ?? {
            id: job.id,
            kind: job.kind,
            status: "starting" as const,
            progressText: "작업을 준비 중입니다.",
          },
      ),
  );
  trustedHandleContract(
    context,
    appOperationIpcContracts.getActiveAppOperations,
    async () => context.operations.activities,
  );
  trustedHandleContract(
    context,
    appOperationIpcContracts.getActiveAppOperation,
    async () => context.operations.currentActivity,
  );
  trustedHandleContract(
    context,
    appOperationIpcContracts.cancelAppOperation,
    async (_event, id) => ({
      accepted: context.operations.requestCancel(id),
    }),
  );
  context.operations.subscribeActivity((event) => {
    const window = context.getMainWindow();
    if (!window || window.isDestroyed()) {
      return;
    }
    window.webContents.send(
      ipcEventContracts.appOperationActivity.channel,
      event,
    );
  });
}

function registerActivityStateIpc(context: AppOperationIpcContext): void {
  let version = 0;
  const snapshot = () => ({
    version,
    activities: context.jobs.gate.activities,
    pages: context.jobs.pageHandoffs.activities,
  });
  const broadcast = () => {
    version += 1;
    const window = context.getMainWindow();
    if (window && !window.isDestroyed())
      window.webContents.send(
        ipcEventContracts.appActivities.channel,
        snapshot(),
      );
  };
  context.jobs.gate.subscribe(broadcast);
  context.jobs.pageHandoffs.subscribe(broadcast);
  trustedHandleContract(
    context,
    appOperationIpcContracts.getAppActivities,
    async () => snapshot(),
  );
  trustedHandleContract(
    context,
    appOperationIpcContracts.finishPageEditHandoff,
    async (_event, response) => context.jobs.pageHandoffs.respond(response),
  );
  trustedHandleContract(
    context,
    appOperationIpcContracts.retryPageEditHandoff,
    async (_event, requestId) => context.jobs.pageHandoffs.retry(requestId),
  );
}
