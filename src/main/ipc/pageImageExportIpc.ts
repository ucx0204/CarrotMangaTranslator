import { dialog } from "electron";
import { pageImageExportIpcContracts } from "../../shared/ipcContracts";
import {
  PageImageExportRequestSchema,
  parseIpcPayload,
} from "../../shared/ipcSchemas";
import type { PageImageExportResult } from "../../shared/pageImageExportTypes";
import {
  assertNoActivePageImageExportJob,
  exportPageImages,
} from "../jobs/pageImageExportJobs";
import type { IpcContext } from "./context";
import { tMain } from "./localization";
import { trustedHandleContract } from "./trustedIpc";

export function registerPageImageExportIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    pageImageExportIpcContracts.exportPageImages,
    async (
      _event,
      rawRequest: unknown,
    ): Promise<PageImageExportResult | null> => {
      const request = parseIpcPayload(
        PageImageExportRequestSchema,
        rawRequest,
        tMain("ipc.labels.resultExport"),
      );
      assertNoActivePageImageExportJob(context);

      const options = {
        title: tMain("dialogs.exportPngFolder"),
        properties: ["openDirectory", "createDirectory"],
      } satisfies Electron.OpenDialogOptions;
      const window = context.getMainWindow();
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      const outputParentDir = result.filePaths[0];
      if (result.canceled || !outputParentDir) {
        return null;
      }

      return exportPageImages(context, request, outputParentDir);
    },
  );
}
