import { DEFAULT_COMIC_DETECTION_SCORE_THRESHOLD } from "./constants";
import {
  isComicDetectionLabelId,
  resolveComicDetectionLabel,
  type ComicDetectionBox,
  type ComicPageDetection,
} from "./contracts";

export type ComicDetectorTensorLike = {
  data: ArrayLike<number | bigint>;
  dims?: readonly number[];
};

export function parseComicDetectorOutputs(
  outputs: Record<string, unknown>,
  imageSize: { width: number; height: number },
  scoreThreshold = DEFAULT_COMIC_DETECTION_SCORE_THRESHOLD,
): ComicPageDetection[] {
  assertImageSize(imageSize);
  assertScoreThreshold(scoreThreshold);
  const labels = requireTensor(outputs.labels, "labels");
  const boxes = requireTensor(outputs.boxes, "boxes");
  const scores = requireTensor(outputs.scores, "scores");
  const count = Math.min(labels.data.length, scores.data.length);
  if (boxes.data.length < count * 4) {
    throw new Error("말풍선 검출기의 boxes 출력 길이가 올바르지 않습니다.");
  }
  const detections: ComicPageDetection[] = [];
  for (let index = 0; index < count; index += 1) {
    const detection = parseDetectionAt(
      labels,
      boxes,
      scores,
      index,
      imageSize,
      scoreThreshold,
    );
    if (detection) detections.push(detection);
  }
  return detections.sort(
    (left, right) => right.score - left.score || left.labelId - right.labelId,
  );
}

function parseDetectionAt(
  labels: ComicDetectorTensorLike,
  boxes: ComicDetectorTensorLike,
  scores: ComicDetectorTensorLike,
  index: number,
  imageSize: { width: number; height: number },
  scoreThreshold: number,
): ComicPageDetection | null {
  const labelId = Number(labels.data[index]);
  const score = Number(scores.data[index]);
  if (
    !isComicDetectionLabelId(labelId) ||
    !Number.isFinite(score) ||
    score < scoreThreshold ||
    score > 1
  ) {
    return null;
  }
  const box = parseDetectionBox(boxes, index, imageSize);
  if (!box) return null;
  return {
    labelId,
    label: resolveComicDetectionLabel(labelId) as ComicPageDetection["label"],
    box,
    score,
  };
}

function parseDetectionBox(
  boxes: ComicDetectorTensorLike,
  index: number,
  imageSize: { width: number; height: number },
): ComicDetectionBox | null {
  const offset = index * 4;
  const values = Array.from({ length: 4 }, (_, coordinate) =>
    Number(boxes.data[offset + coordinate]),
  );
  if (!values.every(Number.isFinite)) return null;
  const box: ComicDetectionBox = [
    clamp(values[0], 0, imageSize.width),
    clamp(values[1], 0, imageSize.height),
    clamp(values[2], 0, imageSize.width),
    clamp(values[3], 0, imageSize.height),
  ];
  return box[2] > box[0] && box[3] > box[1] ? box : null;
}

function requireTensor(value: unknown, name: string): ComicDetectorTensorLike {
  if (
    !value ||
    typeof value !== "object" ||
    !("data" in value) ||
    !isArrayLikeNumeric(value.data)
  ) {
    throw new Error(`말풍선 검출기에 ${name} tensor 출력이 없습니다.`);
  }
  return value as ComicDetectorTensorLike;
}

function isArrayLikeNumeric(
  value: unknown,
): value is ArrayLike<number | bigint> {
  return (
    value !== null &&
    typeof value === "object" &&
    "length" in value &&
    Number.isInteger(Number(value.length)) &&
    Number(value.length) >= 0
  );
}

function assertImageSize(imageSize: { width: number; height: number }): void {
  if (
    !Number.isFinite(imageSize.width) ||
    !Number.isFinite(imageSize.height) ||
    imageSize.width <= 0 ||
    imageSize.height <= 0
  ) {
    throw new Error("말풍선 검출 결과의 원본 이미지 크기가 올바르지 않습니다.");
  }
}

function assertScoreThreshold(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("말풍선 검출 scoreThreshold는 0 이상 1 이하여야 합니다.");
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
