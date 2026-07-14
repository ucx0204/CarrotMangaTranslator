import type { BrowserWindow } from "electron";
import type { AppPaths } from "../appPaths";
import type { ImageDecodeFallback } from "../regionCrop";
import type { ActiveJobStore } from "./activeJob";
import type { InpaintingRevisionStore } from "../inpainting/inpaintingRevisionStore";

export type InpaintingJobContext = {
  appPaths: AppPaths;
  jobs: ActiveJobStore;
  getMainWindow: () => BrowserWindow | null;
  decodeImage: ImageDecodeFallback;
  inpaintingRevisionStore?: InpaintingRevisionStore;
};
