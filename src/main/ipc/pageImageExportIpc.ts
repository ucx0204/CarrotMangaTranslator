import { dialog } from "electron";
import { pageImageExportIpcContracts } from "../../shared/ipcContracts";
import {
  PageImageExportPreflightRequestSchema,
  PageImageExportRequestSchema,
  PagePsdExportRequestSchema,
  parseIpcPayload,
} from "../../shared/ipcSchemas";
import type {
  PageImageExportPreflightResult,
  PageImageExportResult,
} from "../../shared/pageImageExportTypes";
import {
  assertNoActivePageImageExportJob,
  exportPageImages,
  exportPagePsd,
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
  exportPsd?: (
    context: InpaintingJobContext,
    request: Parameters<typeof exportPagePsd>[1],
    outputParentDir: string,
  ) => Promise<PageImageExportResult>;
  preflightImages?: (
    request: Parameters<typeof preflightPageImageExport>[0],
  ) => Promise<PageImageExportPreflightResult>;
};

const productionPageImageExportService: PageImageExportService = {
  assertIdle: assertNoActivePageImageExportJob,
  exportImages: exportPageImages,
  exportPsd: exportPagePsd,
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
  registerExportPreflight(context, service);
  registerRasterExport(context, service);
  registerPsdExport(context, service);
}

function registerExportPreflight(
  context: IpcContext,
  service: PageImageExportService,
): void {
  trustedHandleContract(
    context,
    pageImageExportIpcContracts.preflightPageImages,
    async (_event, rawRequest: unknown) => {
      const request = parseIpcPayload(
        PageImageExportPreflightRequestSchema,
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
}

function registerRasterExport(
  context: IpcContext,
  service: PageImageExportService,
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

      const outputParentDir = await pickExportDirectory(context);
      if (!outputParentDir) return null;

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

function registerPsdExport(
  context: IpcContext,
  service: PageImageExportService,
): void {
  trustedHandleContract(
    context,
    pageImageExportIpcContracts.exportPagePsd,
    async (
      _event,
      rawRequest: unknown,
    ): Promise<PageImageExportResult | null> => {
      const request = parseIpcPayload(
        PagePsdExportRequestSchema,
        rawRequest,
        tMain("ipc.labels.resultExport"),
      );
      service.assertIdle(context);
      const outputParentDir = await pickExportDirectory(context);
      if (!outputParentDir) return null;
      const exported = await (service.exportPsd ?? exportPagePsd)(
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

async function pickExportDirectory(
  context: IpcContext,
): Promise<string | null> {
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
  return result.canceled ? null : (result.filePaths[0] ?? null);
}
