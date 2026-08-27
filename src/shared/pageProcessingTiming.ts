export const PAGE_PROCESSING_TIMING_VERSION = 1 as const;

export const PAGE_PROCESSING_TIMING_STAGES = [
  "preparing",
  "ocr",
  "translation",
  "postprocessing",
  "typography",
  "inpainting",
  "bubbleLayout",
] as const;

export type PageProcessingTimingStage =
  (typeof PAGE_PROCESSING_TIMING_STAGES)[number];

export type PageProcessingTiming = {
  version: typeof PAGE_PROCESSING_TIMING_VERSION;
  stages: Partial<Record<PageProcessingTimingStage, number>>;
  measuredAt: string;
  translationJobId?: string;
  inpaintingJobId?: string;
};
