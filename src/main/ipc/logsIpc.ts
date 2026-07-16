import { shell } from "electron";
import {
  RendererLogRequestSchema,
  parseIpcPayload,
} from "../../shared/ipcSchemas";
import { logsIpcContracts } from "../../shared/ipcContracts";
import { getLogPath, writeLog } from "../logger";
import type { IpcContext } from "./context";
import { tMain } from "./localization";
import { registeredRendererHandleContract } from "./trustedIpc";

export function registerLogsIpc(context: IpcContext): void {
  registeredRendererHandleContract(context, logsIpcContracts.getLogPath, () =>
    getLogPath(),
  );

  registeredRendererHandleContract(
    context,
    logsIpcContracts.openLogFolder,
    async () => {
      await shell.showItemInFolder(getLogPath());
      return { opened: true, logPath: getLogPath() };
    },
  );

  registeredRendererHandleContract(
    context,
    logsIpcContracts.writeLog,
    async (_event, level: unknown, message: unknown, detail?: unknown) => {
      const payload = parseIpcPayload(
        RendererLogRequestSchema,
        { level, message, detail },
        tMain("ipc.labels.logWrite"),
      );
      writeLog(payload.level, `renderer: ${payload.message}`, payload.detail);
      return { logged: true };
    },
  );
}
