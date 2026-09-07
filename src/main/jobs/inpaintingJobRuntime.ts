import { acquireCodexInpaintingEngine } from "../inpainting/codexInpaintingEngine";
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
import { withImageRedactionReview } from "./imageRedactionReview";

export type InpaintingJobRuntime = {
  reviewImages?: typeof withImageRedactionReview;
  acquireEngine: typeof acquireInpaintingEngine;
  acquireCodexEngine?: typeof acquireCodexInpaintingEngine;
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
  reviewImages: withImageRedactionReview,
  acquireEngine: acquireInpaintingEngine,
  acquireCodexEngine: acquireCodexInpaintingEngine,
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
