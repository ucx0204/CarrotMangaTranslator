import { shell } from "electron";
import {
  RendererLogRequestSchema,
  parseIpcPayload,
} from "../../shared/ipcSchemas";
import { logsIpcContracts } from "../../shared/ipcContracts";
import { getLogPath, writeLog } from "../logger";
import {
  type RegisteredRendererIpcContext,
  PRODUCTION_TRUSTED_IPC_RUNTIME,
  registeredRendererHandleContract,
  type TrustedIpcRuntime,
} from "./trustedIpc";

export type LogsIpcRuntime = TrustedIpcRuntime & {
  getLogPath: () => string;
  showItemInFolder: (path: string) => Promise<void> | void;
  writeLog: typeof writeLog;
};

const productionLogsIpcRuntime: LogsIpcRuntime = {
  getLogPath,
  showItemInFolder: (path) => shell.showItemInFolder(path),
  writeLog,
  ...PRODUCTION_TRUSTED_IPC_RUNTIME,
};

export function registerLogsIpc(
  context: RegisteredRendererIpcContext,
  runtime: LogsIpcRuntime = productionLogsIpcRuntime,
): void {
  registeredRendererHandleContract(
    context,
    logsIpcContracts.getLogPath,
    () => runtime.getLogPath(),
    runtime,
  );

  registeredRendererHandleContract(
    context,
    logsIpcContracts.openLogFolder,
    async () => {
      const logPath = runtime.getLogPath();
      await runtime.showItemInFolder(logPath);
      return { opened: true, logPath };
    },
    runtime,
  );

  registeredRendererHandleContract(
    context,
    logsIpcContracts.writeLog,
    async (_event, level: unknown, message: unknown, detail?: unknown) => {
      const payload = parseIpcPayload(
        RendererLogRequestSchema,
        { level, message, detail },
        runtime.translate("ipc.labels.logWrite"),
      );
      runtime.writeLog(
        payload.level,
        `renderer: ${payload.message}`,
        payload.detail,
      );
      return { logged: true };
    },
    runtime,
  );
}
