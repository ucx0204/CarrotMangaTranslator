import { dialog } from "electron";
import { pageImageExportIpcContracts } from "../../shared/ipcContracts";
import {
  PageImageExportRequestSchema,
  parseIpcPayload,
} from "../../shared/ipcSchemas";
import type {
  PageImageExportPreflightResult,
  PageImageExportResult,
} from "../../shared/pageImageExportTypes";
import {
  assertNoActivePageImageExportJob,
  exportPageImages,
} from "../jobs/pageImageExportJobs";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import {
  getRecentDialogDirectory,
  recentDialogPathKeys,
  rememberRecentDialogDirectory,
} from "../recentDialogPaths";
import type { IpcContext } from "./context";
import { tMain } from "./localization";
import { trustedHandleContract } from "./trustedIpc";
import { preflightPageImageExport } from "../jobs/pageImageExportSelection";
import { productionPageImageExportDependencies } from "../jobs/pageImageExportPorts";

export type PageImageExportService = {
  assertIdle: (context: Pick<InpaintingJobContext, "jobs">) => void;
  exportImages: (
    context: InpaintingJobContext,
    request: Parameters<typeof exportPageImages>[1],
    outputParentDir: string,
  ) => Promise<PageImageExportResult>;
  preflightImages?: (
    request: Parameters<typeof preflightPageImageExport>[0],
  ) => Promise<PageImageExportPreflightResult>;
};

const productionPageImageExportService: PageImageExportService = {
  assertIdle: assertNoActivePageImageExportJob,
  exportImages: exportPageImages,
  preflightImages: (request) =>
    preflightPageImageExport(
      request,
      productionPageImageExportDependencies.repository,
    ),
};

export function registerPageImageExportIpc(
  context: IpcContext,
  service: PageImageExportService = productionPageImageExportService,
): void {
  trustedHandleContract(
    context,
    pageImageExportIpcContracts.preflightPageImages,
    async (_event, rawRequest: unknown) => {
      const request = parseIpcPayload(
        PageImageExportRequestSchema,
        rawRequest,
        tMain("ipc.labels.resultExport"),
      );
      const preflightImages =
        service.preflightImages ??
        productionPageImageExportService.preflightImages;
      if (!preflightImages) {
        throw new Error("Page image export preflight is unavailable.");
      }
      return preflightImages({ ...request, expectedTargets: undefined });
    },
  );
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
        title: tMain("dialogs.exportOutputFolder"),
        defaultPath: getRecentDialogDirectory(
          context.appPaths.dataRoot,
          recentDialogPathKeys.pageImageExport,
        ),
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

      const exported = await service.exportImages(
        context,
        request,
        outputParentDir,
      );
      if (exported.status === "completed") {
        rememberRecentDialogDirectory(
          context.appPaths.dataRoot,
          recentDialogPathKeys.pageImageExport,
          outputParentDir,
        );
      }
      return exported;
    },
  );
}
