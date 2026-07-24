import type { BrowserWindow } from "electron";
import type { AppPaths } from "../appPaths";
import type { ActiveJobStore } from "../jobs/activeJob";
import type { PanelWindowRegistry } from "../panelWindows";
import type { ImageDecodeFallback } from "../regionCrop";
import type { InpaintingRevisionStore } from "../inpainting/inpaintingRevisionStore";
import type { SimplePageRuntime } from "../simplePageRuntime";

export type PanelWindowPort = Pick<
  PanelWindowRegistry,
  | "close"
  | "closeAll"
  | "getLastState"
  | "getOpenPanelIds"
  | "isPanelSender"
  | "open"
  | "publishState"
>;

export type IpcContext = {
  appPaths: AppPaths;
  jobs: ActiveJobStore;
  getMainWindow: () => BrowserWindow | null;
  panelWindows: PanelWindowPort;
  errorReportWindows?: {
    isTrustedSender: (webContentsId: number) => boolean;
  };
  isErrorReportSender?: (webContentsId: number) => boolean;
  loadSimplePageRuntime: () => SimplePageRuntime;
  decodeImage: ImageDecodeFallback;
  inpaintingRevisionStore?: InpaintingRevisionStore;
};
