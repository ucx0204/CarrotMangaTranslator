import { inpaintDrawnPatternPage, inpaintPatternPage } from "../inpainting";
import { acquireInpaintingEngine } from "../inpainting/inpaintingEnginePool";
import { openChapter, updatePagesAfterInpainting } from "../library";
import { logError } from "../logger";
import { getAppSettings } from "../settingsStore";
import { emitJobEvent } from "./jobEvents";

export type InpaintingJobRuntime = {
  acquireEngine: typeof acquireInpaintingEngine;
  emitEvent: typeof emitJobEvent;
  getSettings: typeof getAppSettings;
  inpaintDrawnPage: typeof inpaintDrawnPatternPage;
  inpaintPatternPage: typeof inpaintPatternPage;
  logError: typeof logError;
  openChapter: typeof openChapter;
  savePages: typeof updatePagesAfterInpainting;
};

export const productionInpaintingJobRuntime: InpaintingJobRuntime = {
  acquireEngine: acquireInpaintingEngine,
  emitEvent: emitJobEvent,
  getSettings: getAppSettings,
  inpaintDrawnPage: inpaintDrawnPatternPage,
  inpaintPatternPage,
  logError,
  openChapter,
  savePages: updatePagesAfterInpainting,
};
