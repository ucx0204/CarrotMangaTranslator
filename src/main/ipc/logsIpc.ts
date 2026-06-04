import { shell } from "electron";
import { RendererLogRequestSchema, parseIpcPayload } from "../../shared/ipcSchemas";
import { getLogPath, writeLog } from "../logger";
import type { IpcContext } from "./context";
import { trustedHandle } from "./trustedIpc";

export function registerLogsIpc(context: IpcContext): void {
  trustedHandle(context, "logs:get-path", () => getLogPath());

  trustedHandle(context, "logs:open-folder", async () => {
    await shell.showItemInFolder(getLogPath());
    return { opened: true, logPath: getLogPath() };
  });

  trustedHandle(context, "logs:write", async (_event, level: unknown, message: unknown, detail?: unknown) => {
    const payload = parseIpcPayload(RendererLogRequestSchema, { level, message, detail }, "로그 기록");
    writeLog(payload.level, `renderer: ${payload.message}`, payload.detail);
    return { logged: true };
  });
}
