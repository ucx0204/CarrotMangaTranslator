export const PAGE_PROCESSING_TIMING_VERSION = 2 as const;

export const PAGE_PROCESSING_TIMING_STAGES = [
  "preparing",
  "ocr",
  "translation",
  "typography",
  "inpainting",
] as const;

export type PageProcessingTimingStage =
  (typeof PAGE_PROCESSING_TIMING_STAGES)[number];

type LegacyPageProcessingTimingStage =
  | "preparing"
  | "ocr"
  | "translation"
  | "postprocessing"
  | "typography"
  | "inpainting"
  | "bubbleLayout";

export type PageProcessingTimingState = "running" | "interrupted" | "completed";

type LegacyPageProcessingTiming = {
  version: 1;
  stages: Partial<Record<LegacyPageProcessingTimingStage, number>>;
  measuredAt: string;
  translationJobId?: string;
  inpaintingJobId?: string;
};

export type PageProcessingTimingV2 = {
  version: typeof PAGE_PROCESSING_TIMING_VERSION;
  stages: Partial<Record<PageProcessingTimingStage, number>>;
  measuredAt: string;
  sessionId: string;
  state: PageProcessingTimingState;
  checkpoint: number;
  translationJobId?: string;
  inpaintingJobId?: string;
};

export type PageProcessingTiming =
  | LegacyPageProcessingTiming
  | PageProcessingTimingV2;

export type PageTimingSessionRef = {
  id: string;
  startedAtEpochMs: number;
};

export type FinishPageTimingSessionRequest = {
  chapterId: string;
  sessionId: string;
  elapsedMs: number;
  state: Exclude<PageProcessingTimingState, "running">;
};

export type FinishPageTimingSessionResult = {
  updated: boolean;
};

export type PageTimingUpdatedEvent = {
  chapterId: string;
  pageIds: string[];
};

export function normalizePageProcessingTiming(
  timing: PageProcessingTiming | undefined,
): {
  stages: Partial<Record<PageProcessingTimingStage, number>>;
  state: PageProcessingTimingState;
  sessionId?: string;
  checkpoint: number;
} {
  if (!timing) {
    return { stages: {}, state: "interrupted", checkpoint: 0 };
  }
  if (timing.version === PAGE_PROCESSING_TIMING_VERSION) {
    return {
      stages: normalizeCurrentStages(timing.stages),
      state: timing.state,
      sessionId: timing.sessionId,
      checkpoint: normalizeNonNegativeInteger(timing.checkpoint),
    };
  }
  return {
    stages: {
      ...positiveStage("preparing", timing.stages.preparing),
      ...positiveStage("ocr", timing.stages.ocr),
      ...positiveStage(
        "translation",
        sumMilliseconds(
          timing.stages.translation,
          timing.stages.postprocessing,
        ),
      ),
      ...positiveStage(
        "typography",
        sumMilliseconds(timing.stages.typography, timing.stages.bubbleLayout),
      ),
      ...positiveStage("inpainting", timing.stages.inpainting),
    },
    state: "completed",
    checkpoint: 0,
  };
}

export function sumPageProcessingTimingStages(
  stages: Partial<Record<PageProcessingTimingStage, number>>,
): number {
  return PAGE_PROCESSING_TIMING_STAGES.reduce(
    (total, stage) => total + normalizeMilliseconds(stages[stage]),
    0,
  );
}

function normalizeCurrentStages(
  stages: Partial<Record<PageProcessingTimingStage, number>>,
): Partial<Record<PageProcessingTimingStage, number>> {
  return Object.fromEntries(
    PAGE_PROCESSING_TIMING_STAGES.flatMap((stage) => {
      const value = normalizeMilliseconds(stages[stage]);
      return value > 0 ? [[stage, value] as const] : [];
    }),
  );
}

function positiveStage(
  stage: PageProcessingTimingStage,
  value: number | undefined,
): Partial<Record<PageProcessingTimingStage, number>> {
  const normalized = normalizeMilliseconds(value);
  return normalized > 0 ? { [stage]: normalized } : {};
}

function sumMilliseconds(...values: Array<number | undefined>): number {
  return values.reduce<number>(
    (total, value) => total + normalizeMilliseconds(value),
    0,
  );
}

function normalizeMilliseconds(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(Number(value))) : 0;
}

function normalizeNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
