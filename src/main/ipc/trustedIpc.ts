import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { IpcContract } from "../../shared/ipcContracts";
import { isAllowedMainWindowNavigation } from "../mainWindow";
import type { IpcContext } from "./context";
import { tMain } from "./localization";

type TrustedIpcContext = Pick<IpcContext, "getMainWindow">;

function trustedHandle(
  context: TrustedIpcContext,
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
): void {
  ipcMain.handle(
    channel,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      assertTrustedIpcSender(event, context);
      return listener(event, ...args);
    },
  );
}

export function trustedHandleContract<TArgs extends unknown[], TResult>(
  context: TrustedIpcContext,
  contract: IpcContract<TArgs, TResult>,
  listener: (
    event: IpcMainInvokeEvent,
    ...args: TArgs
  ) => Promise<TResult> | TResult,
): void {
  trustedHandle(context, contract.channel, async (event, ...args) => {
    const parsedArgs = contract.args.parse(args) as TArgs;
    const result = await listener(event, ...parsedArgs);
    return contract.result.parse(result) as TResult;
  });
}

function assertTrustedIpcSender(
  event: IpcMainInvokeEvent,
  context: TrustedIpcContext,
): void {
  const mainWindow = context.getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error(tMain("ipc.errors.noWindow"));
  }

  if (event.sender.id !== mainWindow.webContents.id) {
    throw new Error(tMain("ipc.errors.untrusted"));
  }

  const senderFrameUrl = event.senderFrame?.url;
  const rendererUrl = mainWindow.webContents.getURL();
  if (
    !senderFrameUrl ||
    !rendererUrl ||
    !isAllowedMainWindowNavigation(senderFrameUrl, rendererUrl)
  ) {
    throw new Error(tMain("ipc.errors.untrusted"));
  }
}
