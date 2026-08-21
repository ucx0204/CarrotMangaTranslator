import {
  KOHARU_LAYOUT_MASK_SIZE,
  KOHARU_LAYOUT_QUERY_COUNT,
  KOHARU_LAYOUT_SCORE_THRESHOLDS,
} from "./constants";
import {
  isComicDetectionLabelId,
  resolveComicDetectionLabel,
  type ComicDetectionBox,
  type ComicPageDetection,
} from "./contracts";

type KoharuTensorLike = {
  data: ArrayLike<number | bigint>;
  dims?: readonly number[];
  type?: string;
};

const BOX_COORDINATES = 4;
const LOGIT_CLASSES = 5;

export function parseKoharuLayoutOutputs(
  outputs: Record<string, unknown>,
  imageSize: { width: number; height: number },
): ComicPageDetection[] {
  assertImageSize(imageSize);
  const dets = requireTensor(outputs.dets, "dets");
  const labels = requireTensor(outputs.labels, "labels");
  const masks = requireTensor(outputs.masks, "masks");
  assertTensorContract(
    dets,
    [1, KOHARU_LAYOUT_QUERY_COUNT, BOX_COORDINATES],
    "dets",
  );
  assertTensorContract(
    labels,
    [1, KOHARU_LAYOUT_QUERY_COUNT, LOGIT_CLASSES],
    "labels",
  );
  assertTensorContract(
    masks,
    [
      1,
      KOHARU_LAYOUT_QUERY_COUNT,
      KOHARU_LAYOUT_MASK_SIZE,
      KOHARU_LAYOUT_MASK_SIZE,
    ],
    "masks",
  );

  const detections: ComicPageDetection[] = [];
  for (let index = 0; index < KOHARU_LAYOUT_QUERY_COUNT; index += 1) {
    const detection = parseDetectionAt(dets, labels, masks, index, imageSize);
    if (detection) detections.push(detection);
  }
  return detections.sort(
    (left, right) => right.score - left.score || left.labelId - right.labelId,
  );
}

function parseDetectionAt(
  dets: KoharuTensorLike,
  labels: KoharuTensorLike,
  masks: KoharuTensorLike,
  index: number,
  imageSize: { width: number; height: number },
): ComicPageDetection | null {
  const labelOffset = index * LOGIT_CLASSES;
  let labelId = -1;
  let score = -Infinity;
  for (let candidate = 0; candidate < 4; candidate += 1) {
    const candidateScore = sigmoid(
      Number(labels.data[labelOffset + candidate]),
    );
    if (candidateScore > score) {
      labelId = candidate;
      score = candidateScore;
    }
  }
  if (
    !isComicDetectionLabelId(labelId) ||
    !Number.isFinite(score) ||
    score < (KOHARU_LAYOUT_SCORE_THRESHOLDS[labelId] ?? 1)
  ) {
    return null;
  }
  const box = parseNormalizedCxcywh(dets, index, imageSize);
  if (!box) return null;
  const label = resolveComicDetectionLabel(labelId);
  if (!label) return null;
  return {
    labelId,
    label,
    box,
    score,
    mask: copyInstanceMask(masks, index),
  };
}

function parseNormalizedCxcywh(
  dets: KoharuTensorLike,
  index: number,
  imageSize: { width: number; height: number },
): ComicDetectionBox | null {
  const offset = index * BOX_COORDINATES;
  const centerX = Number(dets.data[offset]);
  const centerY = Number(dets.data[offset + 1]);
  const width = Number(dets.data[offset + 2]);
  const height = Number(dets.data[offset + 3]);
  if (
    ![centerX, centerY, width, height].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  const box: ComicDetectionBox = [
    clamp((centerX - width / 2) * imageSize.width, 0, imageSize.width),
    clamp((centerY - height / 2) * imageSize.height, 0, imageSize.height),
    clamp((centerX + width / 2) * imageSize.width, 0, imageSize.width),
    clamp((centerY + height / 2) * imageSize.height, 0, imageSize.height),
  ];
  return box[2] > box[0] && box[3] > box[1] ? box : null;
}

function copyInstanceMask(
  masks: KoharuTensorLike,
  index: number,
): NonNullable<ComicPageDetection["mask"]> {
  const planeSize = KOHARU_LAYOUT_MASK_SIZE * KOHARU_LAYOUT_MASK_SIZE;
  const offset = index * planeSize;
  const logits = new Float32Array(planeSize);
  for (let pixel = 0; pixel < planeSize; pixel += 1) {
    const value = Number(masks.data[offset + pixel]);
    if (!Number.isFinite(value)) {
      throw new Error("KoharuLayout masks 출력에 유한하지 않은 값이 있습니다.");
    }
    logits[pixel] = value;
  }
  return {
    logits,
    width: KOHARU_LAYOUT_MASK_SIZE,
    height: KOHARU_LAYOUT_MASK_SIZE,
  };
}

function requireTensor(value: unknown, name: string): KoharuTensorLike {
  if (
    !value ||
    typeof value !== "object" ||
    !("data" in value) ||
    !isArrayLikeNumeric(value.data)
  ) {
    throw new Error(`KoharuLayout에 ${name} tensor 출력이 없습니다.`);
  }
  return value as KoharuTensorLike;
}

function assertTensorContract(
  tensor: KoharuTensorLike,
  expectedDims: readonly number[],
  name: string,
): void {
  if (
    !Array.isArray(tensor.dims) ||
    tensor.dims.length !== expectedDims.length ||
    tensor.dims.some((value, index) => value !== expectedDims[index])
  ) {
    throw new Error(
      `KoharuLayout ${name} 출력 shape가 올바르지 않습니다: ${JSON.stringify(tensor.dims)}`,
    );
  }
  const expectedLength = expectedDims.reduce(
    (product, value) => product * value,
    1,
  );
  if (tensor.data.length !== expectedLength) {
    throw new Error(
      `KoharuLayout ${name} 출력 길이가 올바르지 않습니다: ${tensor.data.length}/${expectedLength}`,
    );
  }
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
    throw new Error(
      "KoharuLayout 결과의 원본 이미지 크기가 올바르지 않습니다.",
    );
  }
}

function sigmoid(value: number): number {
  if (!Number.isFinite(value)) return Number.NaN;
  return value >= 0
    ? 1 / (1 + Math.exp(-value))
    : Math.exp(value) / (1 + Math.exp(value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
