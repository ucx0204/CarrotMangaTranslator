import { KOHARU_LAYOUT_LABELS } from "./constants";

export type ComicDetectionLabel = (typeof KOHARU_LAYOUT_LABELS)[number];
export type ComicDetectionLabelId = 0 | 1 | 2 | 3;
export type ComicDetectionBox = [number, number, number, number];

export type KoharuInstanceMask = {
  /** Full-page low-resolution mask-logit plane. */
  logits: Float32Array;
  width: number;
  height: number;
};

export type ComicPageDetection = {
  labelId: ComicDetectionLabelId;
  label: ComicDetectionLabel;
  /** Absolute source-image pixel coordinates in x1, y1, x2, y2 order. */
  box: ComicDetectionBox;
  score: number;
  /** KoharuLayout instance mask. Parser-produced detections always carry it. */
  mask?: KoharuInstanceMask;
};

export type ComicPageDetectionResult = {
  imageWidth: number;
  imageHeight: number;
  detections: ComicPageDetection[];
  executionProvider?: "dml" | "cpu";
};

/**
 * Job-local Koharu output passed from the bubble prepass to inpainting.
 * It is never persisted in chapter data: the full-page instance logits are
 * retained only long enough to build the text/SFX erase mask.
 */
export type KoharuTypographySegmentation = Pick<
  ComicPageDetectionResult,
  "imageWidth" | "imageHeight" | "detections"
>;

export type AssociatedComicBubble = {
  bubble: ComicPageDetection;
  textDetections: ComicPageDetection[];
};

export type ComicDetectionAssociations = {
  bubbles: AssociatedComicBubble[];
  unassociatedBubbleText: ComicPageDetection[];
  freeText: ComicPageDetection[];
};

export function resolveComicDetectionLabel(
  labelId: number,
): ComicDetectionLabel | undefined {
  return KOHARU_LAYOUT_LABELS[labelId];
}

export function isComicDetectionLabelId(
  value: number,
): value is ComicDetectionLabelId {
  return Number.isInteger(value) && value >= 0 && value < 4;
}
