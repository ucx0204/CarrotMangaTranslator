import { dialog, ipcMain } from "electron";
import type { CustomFont } from "../../shared/types";
import { listCustomFonts, registerCustomFontFromFile, removeCustomFont } from "../customFonts";
import type { IpcContext } from "./context";

export function registerFontsIpc(context: IpcContext): void {
  ipcMain.handle("fonts:list", async (): Promise<CustomFont[]> => listCustomFonts());

  ipcMain.handle("fonts:register", async (): Promise<CustomFont | null> => {
    const options = {
      title: "폰트 파일 등록 (TTF/OTF)",
      properties: ["openFile"],
      filters: [{ name: "Font", extensions: ["ttf", "otf"] }]
    } satisfies Electron.OpenDialogOptions;
    const window = context.getMainWindow();
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    return registerCustomFontFromFile(result.filePaths[0]);
  });

  ipcMain.handle("fonts:remove", async (_event, id: unknown): Promise<CustomFont[]> => {
    if (typeof id !== "string" || !id) {
      return listCustomFonts();
    }
    return removeCustomFont(id);
  });
}
