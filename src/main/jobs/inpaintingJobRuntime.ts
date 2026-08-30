import { inpaintPatternPage } from "../inpainting";
import { inpaintDrawnPatternPage } from "../inpainting/drawnPatternPage";
import { acquireInpaintingEngine } from "../inpainting/inpaintingEnginePool";
import { createProductionBubbleLayoutRunner } from "../bubbleLayout/bubbleLayoutFacade";
import { disposeCachedKoharuLayoutSessions } from "../bubbleLayout/session";
import { openChapter, updatePagesAfterInpainting } from "../library";
import { logError } from "../logger";
import { getAppSettings } from "../settingsStore";
import type { BubbleLayoutRunnerFactory } from "../inpainting/bubbleLayoutRunner";
import { emitJobEvent } from "./jobEvents";
import {
  pageTimingSessionManager,
  type OpenPageTimingSessionOptions,
} from "./pageTimingSessionManager";
import type { PageProcessingTimingCollector } from "../pipeline/pageProcessingTiming";

export type InpaintingJobRuntime = {
  acquireEngine: typeof acquireInpaintingEngine;
  emitEvent: typeof emitJobEvent;
  getSettings: typeof getAppSettings;
  inpaintDrawnPage: typeof inpaintDrawnPatternPage;
  inpaintPatternPage: typeof inpaintPatternPage;
  logError: typeof logError;
  openPageTimingSession: (
    options: OpenPageTimingSessionOptions,
  ) => Promise<PageProcessingTimingCollector>;
  openChapter: typeof openChapter;
  savePages: typeof updatePagesAfterInpainting;
  createBubbleLayoutRunner?: BubbleLayoutRunnerFactory;
  disposeBubbleLayoutSessions?: typeof disposeCachedKoharuLayoutSessions;
};

export const productionInpaintingJobRuntime: InpaintingJobRuntime = {
  acquireEngine: acquireInpaintingEngine,
  createBubbleLayoutRunner: createProductionBubbleLayoutRunner,
  disposeBubbleLayoutSessions: disposeCachedKoharuLayoutSessions,
  emitEvent: emitJobEvent,
  getSettings: getAppSettings,
  inpaintDrawnPage: inpaintDrawnPatternPage,
  inpaintPatternPage,
  logError,
  openPageTimingSession: pageTimingSessionManager.open.bind(
    pageTimingSessionManager,
  ),
  openChapter,
  savePages: updatePagesAfterInpainting,
};
