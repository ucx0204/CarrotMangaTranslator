import { dialog } from "electron";
import type { CustomFont } from "../../shared/types";
import { listCustomFonts, registerCustomFontFromFile, removeCustomFont } from "../customFonts";
import type { IpcContext } from "./context";
import { trustedHandle } from "./trustedIpc";

export function registerFontsIpc(context: IpcContext): void {
  trustedHandle(context, "fonts:list", async (): Promise<CustomFont[]> => listCustomFonts());

  trustedHandle(context, "fonts:register", async (): Promise<CustomFont | null> => {
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

  trustedHandle(context, "fonts:remove", async (_event, id: unknown): Promise<CustomFont[]> => {
    if (typeof id !== "string" || !id) {
      return listCustomFonts();
    }
    return removeCustomFont(id);
  });
}
