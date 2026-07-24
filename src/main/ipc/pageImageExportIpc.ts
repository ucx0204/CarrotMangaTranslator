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
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { IpcContext } from "./context";
import { tMain } from "./localization";
import { trustedHandleContract } from "./trustedIpc";

export type PageImageExportService = {
  assertIdle: (context: Pick<InpaintingJobContext, "jobs">) => void;
  exportImages: (
    context: InpaintingJobContext,
    request: Parameters<typeof exportPageImages>[1],
    outputParentDir: string,
  ) => Promise<PageImageExportResult>;
};

const productionPageImageExportService: PageImageExportService = {
  assertIdle: assertNoActivePageImageExportJob,
  exportImages: exportPageImages,
};

export function registerPageImageExportIpc(
  context: IpcContext,
  service: PageImageExportService = productionPageImageExportService,
): void {
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
      service.assertIdle(context);

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

      return service.exportImages(context, request, outputParentDir);
    },
  );
}
