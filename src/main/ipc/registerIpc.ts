import type { IpcContext } from "./context";
import { registerImportShareIpc } from "./importShareIpc";
import { registerInpaintingIpc } from "./inpaintingIpc";
import { registerJobControlIpc } from "./jobControlIpc";
import { registerLibraryIpc } from "./libraryIpc";
import { registerLogsIpc } from "./logsIpc";
import { registerSettingsIpc } from "./settingsIpc";
import { registerTranslationJobIpc } from "./translationJobIpc";

export function registerIpc(context: IpcContext): void {
  registerLogsIpc();
  registerSettingsIpc(context);
  registerLibraryIpc();
  registerImportShareIpc(context);
  registerTranslationJobIpc(context);
  registerInpaintingIpc(context);
  registerJobControlIpc(context);
}
