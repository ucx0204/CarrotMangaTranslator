import type {
  openChapter,
  getRunPaths,
  resolveWorkContextForChapter,
} from "../library";
import type { StartSoundEffectTranslationRequest } from "../../shared/analysisTypes";
import type { ChapterSnapshot } from "../../shared/libraryTypes";
import type { JobEvent } from "../../shared/jobTypes";
import type { JobResourceCleanup } from "./jobLifetimeCleanup";
import type { BrowserWindow } from "electron";
import type { ImageDecodeFallback } from "../regionCrop";
import type { ActiveJobStore } from "./activeJob";

export type TranslationJobContext = {
  inpaintingRevisionStore?: import("../inpainting/inpaintingRevisionStore").InpaintingRevisionStore;
  jobs: ActiveJobStore;
  getMainWindow: () => BrowserWindow | null;
  decodeImage: ImageDecodeFallback;
};

export type SoundEffectTranslationJobInput = {
  context: TranslationJobContext;
  request: StartSoundEffectTranslationRequest;
  id: string;
  abortController: AbortController;
  emit: (event: JobEvent) => void;
  state: SoundEffectTranslationJobState;
  registerResourceCleanup: (cleanup: JobResourceCleanup) => void;
};

export type SoundEffectTranslationJobState = {
  chapter: ChapterSnapshot | null;
  createdBlocksByPage: Array<{ pageId: string; blockIds: string[] }>;
  translatedRegionCount: number;
  warnings: string[];
};

export type SoundEffectPreparationDependencies = {
  openChapter: typeof openChapter;
  getRunPaths: typeof getRunPaths;
  resolveWorkContext: typeof resolveWorkContextForChapter;
};
