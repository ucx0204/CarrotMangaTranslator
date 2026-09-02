import { dialog } from "electron";
import { pageImageExportIpcContracts } from "../../shared/ipcContracts";
import {
  PageImageExportPreflightRequestSchema,
  PageImageExportRequestSchema,
  PagePsdExportRequestSchema,
  parseIpcPayload,
} from "../../shared/ipcSchemas";
import {
  PageImageExportApplicationService,
  type PageImageExportExecutionPort,
} from "../application/pageImageExportService";
import {
  assertNoActivePageImageExportJob,
  exportPageImages,
  exportPagePsd,
} from "../jobs/pageImageExportJobs";
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

export type PageImageExportService = PageImageExportExecutionPort;

export function registerPageImageExportIpc(
  context: IpcContext,
  service: PageImageExportService = createProductionExecution(context),
): void {
  const application = new PageImageExportApplicationService(service, {
    pick: () => pickExportDirectory(context),
    remember: (directory) =>
      rememberRecentDialogDirectory(
        context.appPaths.dataRoot,
        recentDialogPathKeys.pageImageExport,
        directory,
      ),
  });
  registerExportPreflight(context, application);
  registerRasterExport(context, application);
  registerPsdExport(context, application);
}

function registerExportPreflight(
  context: IpcContext,
  application: PageImageExportApplicationService,
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
      return application.preflight(request);
    },
  );
}

function registerRasterExport(
  context: IpcContext,
  application: PageImageExportApplicationService,
): void {
  trustedHandleContract(
    context,
    pageImageExportIpcContracts.exportPageImages,
    async (_event, rawRequest: unknown) => {
      const request = parseIpcPayload(
        PageImageExportRequestSchema,
        rawRequest,
        tMain("ipc.labels.resultExport"),
      );
      return application.exportImages(request);
    },
  );
}

function registerPsdExport(
  context: IpcContext,
  application: PageImageExportApplicationService,
): void {
  trustedHandleContract(
    context,
    pageImageExportIpcContracts.exportPagePsd,
    async (_event, rawRequest: unknown) => {
      const request = parseIpcPayload(
        PagePsdExportRequestSchema,
        rawRequest,
        tMain("ipc.labels.resultExport"),
      );
      return application.exportPsd(request);
    },
  );
}

function createProductionExecution(
  context: IpcContext,
): PageImageExportExecutionPort {
  return {
    assertIdle: () => assertNoActivePageImageExportJob(context),
    exportImages: (request, outputParentDir) =>
      exportPageImages(context, request, outputParentDir),
    exportPsd: (request, outputParentDir) =>
      exportPagePsd(context, request, outputParentDir),
    preflight: (request) =>
      preflightPageImageExport(
        request,
        productionPageImageExportDependencies.repository,
      ),
  };
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
