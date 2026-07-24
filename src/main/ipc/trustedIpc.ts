import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { IpcContract } from "../../shared/ipcContracts";
import { isAllowedMainWindowNavigation } from "../mainWindow";
import { tMain } from "./localization";

type TrustedRendererWindowPort = {
  isDestroyed: () => boolean;
  webContents: {
    id: number;
    getURL: () => string;
  };
};

export type TrustedIpcContext = {
  getMainWindow: () => TrustedRendererWindowPort | null;
};

export type RegisteredRendererIpcContext = TrustedIpcContext & {
  errorReportWindows?: {
    isTrustedSender: (webContentsId: number) => boolean;
  };
  isErrorReportSender?: (webContentsId: number) => boolean;
  panelWindows: {
    isPanelSender: (webContentsId: number) => boolean;
  };
};

export type TrustedIpcRuntime = {
  isAllowedNavigation: (
    targetUrl: string,
    allowedRendererUrl: string,
  ) => boolean;
  translate: (key: string) => string;
};

export const PRODUCTION_TRUSTED_IPC_RUNTIME: TrustedIpcRuntime = {
  isAllowedNavigation: isAllowedMainWindowNavigation,
  translate: tMain,
};

function trustedHandle(
  context: TrustedIpcContext,
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  runtime: TrustedIpcRuntime,
): void {
  ipcMain.handle(
    channel,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      assertTrustedIpcSender(event, context, runtime);
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
  runtime: TrustedIpcRuntime = PRODUCTION_TRUSTED_IPC_RUNTIME,
): void {
  trustedHandle(
    context,
    contract.channel,
    async (event, ...args) => {
      const parsedArgs = contract.args.parse(args) as TArgs;
      const result = await listener(event, ...parsedArgs);
      return contract.result.parse(result) as TResult;
    },
    runtime,
  );
}

export function registeredRendererHandleContract<
  TArgs extends unknown[],
  TResult,
>(
  context: RegisteredRendererIpcContext,
  contract: IpcContract<TArgs, TResult>,
  listener: (
    event: IpcMainInvokeEvent,
    ...args: TArgs
  ) => Promise<TResult> | TResult,
  runtime: TrustedIpcRuntime = PRODUCTION_TRUSTED_IPC_RUNTIME,
): void {
  ipcMain.handle(
    contract.channel,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      assertRegisteredRendererIpcSender(event, context, runtime);
      const parsedArgs = contract.args.parse(args) as TArgs;
      const result = await listener(event, ...parsedArgs);
      return contract.result.parse(result) as TResult;
    },
  );
}

function assertTrustedIpcSender(
  event: IpcMainInvokeEvent,
  context: TrustedIpcContext,
  runtime: TrustedIpcRuntime,
): void {
  const mainWindow = context.getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error(runtime.translate("ipc.errors.noWindow"));
  }

  if (event.sender.id !== mainWindow.webContents.id) {
    throw new Error(runtime.translate("ipc.errors.untrusted"));
  }

  const senderFrameUrl = event.senderFrame?.url;
  const rendererUrl = mainWindow.webContents.getURL();
  if (
    !senderFrameUrl ||
    !rendererUrl ||
    !runtime.isAllowedNavigation(senderFrameUrl, rendererUrl)
  ) {
    throw new Error(runtime.translate("ipc.errors.untrusted"));
  }
}

function assertRegisteredRendererIpcSender(
  event: IpcMainInvokeEvent,
  context: RegisteredRendererIpcContext,
  runtime: TrustedIpcRuntime,
): void {
  if (isDedicatedErrorReportSender(event.sender.id, context)) {
    return;
  }

  const mainWindow = context.getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error(runtime.translate("ipc.errors.untrusted"));
  }
  const senderFrameUrl = event.senderFrame?.url;
  const rendererUrl = mainWindow.webContents.getURL();
  if (
    !isMainOrPanelSender(event.sender.id, mainWindow.webContents.id, context) ||
    !senderFrameUrl ||
    !rendererUrl ||
    !runtime.isAllowedNavigation(senderFrameUrl, rendererUrl)
  ) {
    throw new Error(runtime.translate("ipc.errors.untrusted"));
  }
}

function isDedicatedErrorReportSender(
  webContentsId: number,
  context: RegisteredRendererIpcContext,
): boolean {
  return Boolean(
    context.isErrorReportSender?.(webContentsId) ||
    context.errorReportWindows?.isTrustedSender(webContentsId),
  );
}

function isMainOrPanelSender(
  webContentsId: number,
  mainWebContentsId: number,
  context: RegisteredRendererIpcContext,
): boolean {
  return (
    webContentsId === mainWebContentsId ||
    context.panelWindows.isPanelSender(webContentsId)
  );
}
