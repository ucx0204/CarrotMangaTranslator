import type { IpcContext } from "./context";
import { registerExternalLinksIpc } from "./externalLinksIpc";
import { registerFontsIpc } from "./fontsIpc";
import { registerImportShareIpc } from "./importShareIpc";
import { registerInpaintingIpc } from "./inpaintingIpc";
import { registerJobControlIpc } from "./jobControlIpc";
import { registerLibraryIpc } from "./libraryIpc";
import { registerLogsIpc } from "./logsIpc";
import { registerSettingsIpc } from "./settingsIpc";
import { registerTextExportIpc } from "./textExportIpc";
import { registerTranslationJobIpc } from "./translationJobIpc";

export function registerIpc(context: IpcContext): void {
  registerExternalLinksIpc(context);
  registerLogsIpc(context);
  registerSettingsIpc(context);
  registerLibraryIpc(context);
  registerFontsIpc(context);
  registerImportShareIpc(context);
  registerTextExportIpc(context);
  registerTranslationJobIpc(context);
  registerInpaintingIpc(context);
  registerJobControlIpc(context);
}
