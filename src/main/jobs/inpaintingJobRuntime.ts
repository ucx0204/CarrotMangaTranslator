import { inpaintDrawnPatternPage, inpaintPatternPage } from "../inpainting";
import { acquireInpaintingEngine } from "../inpainting/inpaintingEnginePool";
import { createProductionBubbleLayoutRunner } from "../bubbleLayout/bubbleLayoutFacade";
import { openChapter, updatePagesAfterInpainting } from "../library";
import { logError } from "../logger";
import { getAppSettings } from "../settingsStore";
import type { BubbleLayoutRunnerFactory } from "../inpainting/bubbleLayoutRunner";
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
  createBubbleLayoutRunner?: BubbleLayoutRunnerFactory;
};

export const productionInpaintingJobRuntime: InpaintingJobRuntime = {
  acquireEngine: acquireInpaintingEngine,
  createBubbleLayoutRunner: createProductionBubbleLayoutRunner,
  emitEvent: emitJobEvent,
  getSettings: getAppSettings,
  inpaintDrawnPage: inpaintDrawnPatternPage,
  inpaintPatternPage,
  logError,
  openChapter,
  savePages: updatePagesAfterInpainting,
};
