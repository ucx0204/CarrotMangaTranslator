import { BrowserWindow, dialog } from "electron";
import { fontIpcContracts, ipcEventContracts } from "../../shared/ipcContracts";
import type {
  CustomFont,
  FontLibrarySnapshot,
  FontPreferences,
} from "../../shared/libraryTypes";
import {
  getFontLibrarySnapshot,
  listCustomFonts,
  registerCustomFontFromFile,
  removeCustomFont,
  saveFontPreferences,
} from "../customFonts";
import type { IpcContext } from "./context";
import { trustedHandleContract } from "./trustedIpc";
import { tMain } from "./localization";

export function registerFontsIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    fontIpcContracts.getFontLibrary,
    async (): Promise<FontLibrarySnapshot> => getFontLibrarySnapshot(),
  );

  trustedHandleContract(
    context,
    fontIpcContracts.saveFontPreferences,
    async (
      _event,
      preferences: FontPreferences,
    ): Promise<FontLibrarySnapshot> => {
      const customFonts = listCustomFonts();
      saveFontPreferences(preferences, customFonts);
      const snapshot = getFontLibrarySnapshot();
      broadcastFontLibrary(snapshot);
      return snapshot;
    },
  );

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
      const font = registerCustomFontFromFile(result.filePaths[0]);
      broadcastFontLibrary(getFontLibrarySnapshot());
      return font;
    },
  );

  trustedHandleContract(
    context,
    fontIpcContracts.removeCustomFont,
    async (_event, id: unknown): Promise<CustomFont[]> => {
      if (typeof id !== "string" || !id) {
        return listCustomFonts();
      }
      const remaining = removeCustomFont(id);
      broadcastFontLibrary(getFontLibrarySnapshot());
      return remaining;
    },
  );
}

function broadcastFontLibrary(snapshot: FontLibrarySnapshot): void {
  const payload = ipcEventContracts.fontLibraryChanged.payload.parse(snapshot);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(
        ipcEventContracts.fontLibraryChanged.channel,
        payload,
      );
    }
  }
}
