import { appOperationIpcContracts } from "../../shared/ipcAppOperationContracts";
import { ipcEventContracts } from "../../shared/ipcEventContracts";
import type { IpcContext } from "./context";
import { trustedHandleContract } from "./trustedIpc";

type AppOperationIpcContext = Pick<IpcContext, "getMainWindow" | "operations">;

export function registerAppOperationIpc(context: AppOperationIpcContext): void {
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
