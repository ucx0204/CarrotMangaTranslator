import { COMIC_DETECTION_LABELS } from "./constants";

export type ComicDetectionLabel = (typeof COMIC_DETECTION_LABELS)[number];
export type ComicDetectionLabelId = 0 | 1 | 2;
export type ComicDetectionBox = [number, number, number, number];

export type ComicPageDetection = {
  labelId: ComicDetectionLabelId;
  label: ComicDetectionLabel;
  /** Absolute source-image pixel coordinates in x1, y1, x2, y2 order. */
  box: ComicDetectionBox;
  score: number;
};

export type ComicPageDetectionResult = {
  imageWidth: number;
  imageHeight: number;
  detections: ComicPageDetection[];
};

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
  return COMIC_DETECTION_LABELS[labelId];
}

export function isComicDetectionLabelId(
  value: number,
): value is ComicDetectionLabelId {
  return Number.isInteger(value) && value >= 0 && value < 3;
}
