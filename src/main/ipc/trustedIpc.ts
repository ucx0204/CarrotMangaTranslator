import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { IpcContext } from "./context";

let guardInstalled = false;

export function installTrustedIpcGuard(context: IpcContext): void {
  if (guardInstalled) {
    return;
  }
  guardInstalled = true;

  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = ((channel, listener) =>
    originalHandle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      assertTrustedIpcSender(event, context);
      return listener(event, ...args);
    })) as typeof ipcMain.handle;
}

export function assertTrustedIpcSender(event: IpcMainInvokeEvent, context: IpcContext): void {
  const mainWindow = context.getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("IPC 요청을 받을 앱 창이 없습니다.");
  }

  if (event.sender.id !== mainWindow.webContents.id) {
    throw new Error("신뢰할 수 없는 IPC 요청입니다.");
  }
}
