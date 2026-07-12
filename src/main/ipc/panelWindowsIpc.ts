import { ipcMain, type IpcMainInvokeEvent } from "electron";
import {
  ipcEventContracts,
  panelWindowIpcContracts,
} from "../../shared/ipcContracts";
import type { PanelCommand } from "../../shared/panelBridgeTypes";
import { isAllowedMainWindowNavigation } from "../mainWindow";
import type { IpcContext } from "./context";
import { tMain } from "./localization";
import { trustedHandleContract } from "./trustedIpc";

export function registerPanelWindowsIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    panelWindowIpcContracts.openPanelWindow,
    (_event, panelId) => ({ opened: context.panelWindows.open(panelId) }),
  );
  trustedHandleContract(
    context,
    panelWindowIpcContracts.closePanelWindow,
    (_event, panelId) => ({ closed: context.panelWindows.close(panelId) }),
  );
  trustedHandleContract(
    context,
    panelWindowIpcContracts.publishPanelState,
    (_event, state) => {
      context.panelWindows.publishState(state);
      return { published: true };
    },
  );
  registerGetPanelState(context);
  registerSendPanelCommand(context);
}

// Pop-out windows pull the current snapshot on mount so they never miss the
// initial state to a push/subscribe race. Panel-scoped trust check applies.
function registerGetPanelState(context: IpcContext): void {
  const contract = panelWindowIpcContracts.getPanelState;
  ipcMain.handle(
    contract.channel,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      assertPanelWindowSender(event, context);
      contract.args.parse(args);
      return contract.result.parse(context.panelWindows.getLastState());
    },
  );
}

// Panel-command comes from a popped-out window, whose webContents id differs
// from the main window, so it uses a panel-scoped trust check instead of the
// main-window assertion. The command is relayed to the main window, which
// applies it through the existing session action handlers.
function registerSendPanelCommand(context: IpcContext): void {
  const contract = panelWindowIpcContracts.sendPanelCommand;
  ipcMain.handle(
    contract.channel,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      assertPanelWindowSender(event, context);
      const [command] = contract.args.parse(args) as [PanelCommand];
      const mainWindow = context.getMainWindow();
      const delivered = Boolean(mainWindow && !mainWindow.isDestroyed());
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(
          ipcEventContracts.panelCommand.channel,
          ipcEventContracts.panelCommand.payload.parse(command),
        );
      }
      return contract.result.parse({ sent: delivered });
    },
  );
}

function assertPanelWindowSender(
  event: IpcMainInvokeEvent,
  context: IpcContext,
): void {
  if (!context.panelWindows.isPanelSender(event.sender.id)) {
    throw new Error(tMain("ipc.errors.untrustedPanel"));
  }
  const rendererUrl = context.getMainWindow()?.webContents.getURL();
  const senderFrameUrl = event.senderFrame?.url;
  if (
    !senderFrameUrl ||
    !rendererUrl ||
    !isAllowedMainWindowNavigation(senderFrameUrl, rendererUrl)
  ) {
    throw new Error(tMain("ipc.errors.untrustedPanel"));
  }
}
