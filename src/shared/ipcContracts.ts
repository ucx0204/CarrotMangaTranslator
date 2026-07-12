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
  translationJobIpcContracts,
} from "./ipcJobContracts";
import {
  externalIpcContracts,
  logsIpcContracts,
  panelWindowIpcContracts,
} from "./ipcSystemContracts";
import { ipcEventContracts } from "./ipcEventContracts";

export type { IpcContract, IpcEventContract };
export {
  externalIpcContracts,
  fontIpcContracts,
  importShareIpcContracts,
  inpaintingIpcContracts,
  ipcEventContracts,
  jobControlIpcContracts,
  libraryIpcContracts,
  logsIpcContracts,
  panelWindowIpcContracts,
  settingsIpcContracts,
  textReviewIpcContracts,
  translationJobIpcContracts,
  workContextIpcContracts,
};

export const ipcInvokeContracts = {
  ...importShareIpcContracts,
  ...libraryIpcContracts,
  ...workContextIpcContracts,
  ...textReviewIpcContracts,
  ...fontIpcContracts,
  ...settingsIpcContracts,
  ...externalIpcContracts,
  ...logsIpcContracts,
  ...translationJobIpcContracts,
  ...inpaintingIpcContracts,
  ...jobControlIpcContracts,
  ...panelWindowIpcContracts,
} as const;
