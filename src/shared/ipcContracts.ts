import type { IpcContract, IpcEventContract } from "./ipcContractCore";
import {
  importShareIpcContracts,
  libraryIpcContracts,
} from "./ipcImportLibraryContracts";
import {
  fontIpcContracts,
  settingsIpcContracts,
  textReviewIpcContracts,
  workContextIpcContracts,
} from "./ipcContextSettingsContracts";
import {
  inpaintingIpcContracts,
  jobControlIpcContracts,
  pageImageExportIpcContracts,
  translationJobIpcContracts,
} from "./ipcJobContracts";
import {
  errorReportIpcContracts,
  externalIpcContracts,
  logsIpcContracts,
  panelWindowIpcContracts,
} from "./ipcSystemContracts";
import { ipcEventContracts } from "./ipcEventContracts";
import { webImportIpcContracts } from "./ipcWebImportContracts";
import { blockLibraryIpcContracts } from "./ipcBlockLibraryContracts";
import { conditionalBatchIpcContracts } from "./ipcConditionalBatchContracts";
import { linkedWorkspaceIpcContracts } from "./ipcLinkedWorkspaceContracts";
import { appOperationIpcContracts } from "./ipcAppOperationContracts";

export type { IpcContract, IpcEventContract };
export {
  errorReportIpcContracts,
  blockLibraryIpcContracts,
  externalIpcContracts,
  fontIpcContracts,
  importShareIpcContracts,
  inpaintingIpcContracts,
  ipcEventContracts,
  jobControlIpcContracts,
  linkedWorkspaceIpcContracts,
  libraryIpcContracts,
  logsIpcContracts,
  pageImageExportIpcContracts,
  panelWindowIpcContracts,
  settingsIpcContracts,
  textReviewIpcContracts,
  translationJobIpcContracts,
  workContextIpcContracts,
};

export const ipcInvokeContracts = {
  ...appOperationIpcContracts,
  ...blockLibraryIpcContracts,
  ...conditionalBatchIpcContracts,
  ...importShareIpcContracts,
  ...libraryIpcContracts,
  ...workContextIpcContracts,
  ...textReviewIpcContracts,
  ...fontIpcContracts,
  ...settingsIpcContracts,
  ...externalIpcContracts,
  ...errorReportIpcContracts,
  ...logsIpcContracts,
  ...translationJobIpcContracts,
  ...inpaintingIpcContracts,
  ...pageImageExportIpcContracts,
  ...linkedWorkspaceIpcContracts,
  ...jobControlIpcContracts,
  ...panelWindowIpcContracts,
  ...webImportIpcContracts,
} as const;
