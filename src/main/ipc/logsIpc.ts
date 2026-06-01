import { ipcMain, shell } from "electron";
import { RendererLogRequestSchema, parseIpcPayload } from "../../shared/ipcSchemas";
import { getLogPath, writeLog } from "../logger";

export function registerLogsIpc(): void {
  ipcMain.handle("logs:get-path", () => getLogPath());

  ipcMain.handle("logs:open-folder", async () => {
    await shell.showItemInFolder(getLogPath());
    return { opened: true, logPath: getLogPath() };
  });

  ipcMain.handle("logs:write", async (_event, level: unknown, message: unknown, detail?: unknown) => {
    const payload = parseIpcPayload(RendererLogRequestSchema, { level, message, detail }, "로그 기록");
    writeLog(payload.level, `renderer: ${payload.message}`, payload.detail);
    return { logged: true };
  });
}
