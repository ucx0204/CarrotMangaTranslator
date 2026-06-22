import type { BrowserWindow } from "electron";
import type { ImageDecodeFallback } from "../regionCrop";
import type { ActiveJobStore } from "./activeJob";

export type TranslationJobContext = {
  jobs: ActiveJobStore;
  getMainWindow: () => BrowserWindow | null;
  decodeImage: ImageDecodeFallback;
};
