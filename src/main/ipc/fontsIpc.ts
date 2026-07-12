import { dialog } from "electron";
import { fontIpcContracts } from "../../shared/ipcContracts";
import type { CustomFont } from "../../shared/libraryTypes";
import {
  listCustomFonts,
  registerCustomFontFromFile,
  removeCustomFont,
} from "../customFonts";
import type { IpcContext } from "./context";
import { trustedHandleContract } from "./trustedIpc";
import { tMain } from "./localization";

export function registerFontsIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    fontIpcContracts.listCustomFonts,
    async (): Promise<CustomFont[]> => listCustomFonts(),
  );

  trustedHandleContract(
    context,
    fontIpcContracts.registerCustomFont,
    async (): Promise<CustomFont | null> => {
      const options = {
        title: tMain("dialogs.registerFont"),
        properties: ["openFile"],
        filters: [
          {
            name: tMain("dialogs.filters.font"),
            extensions: ["ttf", "otf"],
          },
        ],
      } satisfies Electron.OpenDialogOptions;
      const window = context.getMainWindow();
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths[0]) {
        return null;
      }
      return registerCustomFontFromFile(result.filePaths[0]);
    },
  );

  trustedHandleContract(
    context,
    fontIpcContracts.removeCustomFont,
    async (_event, id: unknown): Promise<CustomFont[]> => {
      if (typeof id !== "string" || !id) {
        return listCustomFonts();
      }
      return removeCustomFont(id);
    },
  );
}
