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

type MaskedDetection = ComicPageDetection & {
  mask: NonNullable<ComicPageDetection["mask"]>;
};

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
  const maskIndex = maskPlaneLookup(masks, outputs.queries);

  const ranked = Array.from({ length: labels.data.length }, (_, slot) => ({
    slot,
    score: sigmoid(Number(labels.data[slot])),
  }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, 160);
  const queries = new Map<number, ComicPageDetection>();
  for (const { slot, score } of ranked) {
    const labelId = slot % LOGIT_CLASSES;
    if (
      !isComicDetectionLabelId(labelId) ||
      score <= KOHARU_LAYOUT_SCORE_THRESHOLDS[labelId]
    )
      continue;
    const query = Math.floor(slot / LOGIT_CLASSES);
    // Any qualifying text label takes precedence for this query.
    if (queries.has(query) && labelId !== 0) continue;
    const box = parseNormalizedCxcywh(dets, query, imageSize);
    if (box)
      queries.set(query, {
        labelId,
        label: resolveComicDetectionLabel(labelId),
        score,
        box,
      });
  }
  const kept: MaskedDetection[] = [];
  for (const [query, detection] of [...queries].sort(
    (a, b) => b[1].score - a[1].score,
  )) {
    if (
      detection.label !== "onomatopoeia" &&
      kept.some((other) => {
        if (other.label !== detection.label) return false;
        const { iou, nested } = overlap(detection.box, other.box);
        return iou >= 0.5 || (detection.label === "text" && nested >= 0.8);
      })
    )
      continue;
    const mask = copyInstanceMask(masks, maskIndex(query), imageSize);
    if (detection.labelId < 2)
      clipLetteringMask(mask, detection.box, imageSize);
    kept.push({ ...detection, mask });
  }
  const detections = mergeSoundEffects(kept);
  assignSharedLetteringPixels(detections);
  return detections;
}

function maskPlaneLookup(masks: KoharuTensorLike, queries: unknown) {
  const indices = sparseMaskIndices(queries);
  assertTensorContract(
    masks,
    [
      1,
      indices?.size ?? KOHARU_LAYOUT_QUERY_COUNT,
      KOHARU_LAYOUT_MASK_SIZE,
      KOHARU_LAYOUT_MASK_SIZE,
    ],
    "masks",
  );
  return (query: number) => {
    const index = indices ? indices.get(query) : query;
    if (index === undefined)
      throw new Error("KoharuLayout selected mask is missing.");
    return index;
  };
}

function sparseMaskIndices(value: unknown) {
  if (value === undefined) return;
  const tensor = requireTensor(value, "queries");
  const count = tensor.data.length;
  assertTensorContract(tensor, [count], "queries");
  const result = new Map<number, number>();
  let previous = -1;
  for (let i = 0; i < count; i++) {
    const id = Number(tensor.data[i]);
    if (
      !Number.isInteger(id) ||
      id <= previous ||
      id >= KOHARU_LAYOUT_QUERY_COUNT
    )
      throw new Error("Invalid KoharuLayout mask index.");
    result.set(id, i);
    previous = id;
  }
  return result;
}

function clipLetteringMask(
  mask: MaskedDetection["mask"],
  box: ComicDetectionBox,
  page: { width: number; height: number },
): void {
  const width = box[2] - box[0],
    height = box[3] - box[1];
  const reach = Math.max(
    1,
    Math.min(127, Math.round((6 * Math.max(page.width, page.height)) / 1024)),
  );
  const across = height >= width ? reach : height;
  const down = height >= width ? width : reach;
  const x1 = ((box[0] - across) * mask.width) / page.width;
  const x2 = ((box[2] + across) * mask.width) / page.width;
  const y1 = ((box[1] - down) * mask.height) / page.height;
  const y2 = ((box[3] + down) * mask.height) / page.height;
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (y + 0.5 < y1 || y + 0.5 >= y2 || x + 0.5 < x1 || x + 0.5 >= x2) {
        const i = y * mask.width + x;
        mask.logits[i] = Math.min(mask.logits[i], -1);
      }
    }
  }
}

// A smaller lettering (such as an aside inside a balloon) owns any glyphs
// that a larger detection also covers. Bubble and panel masks may overlap.
function assignSharedLetteringPixels(detections: MaskedDetection[]): void {
  const lettering = detections
    .filter((d) => d.labelId < 2)
    .sort((a, b) => boxArea(a.box) - boxArea(b.box));
  const first = lettering[0];
  if (!first || lettering.length < 2) return;
  const claimed = new Uint8Array(first.mask.logits.length);
  for (const { mask } of lettering) {
    for (let i = 0; i < claimed.length; i++) {
      if (mask.logits[i] <= 0) continue;
      if (claimed[i]) mask.logits[i] = -mask.logits[i];
      else claimed[i] = 1;
    }
  }
}

function boxArea(box: ComicDetectionBox): number {
  return (box[2] - box[0]) * (box[3] - box[1]);
}

function overlap(a: ComicDetectionBox, b: ComicDetectionBox) {
  const both =
    Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const left = boxArea(a),
    right = boxArea(b);
  return {
    iou: both / (left + right - both),
    nested: both / Math.min(left, right),
  };
}

// Nested sound effects may be distinct words. Merge only when both boxes
// and at least half of the smaller instance's positive mask overlap.
function mergeSoundEffects(detections: MaskedDetection[]): MaskedDetection[] {
  let effects = detections.filter((d) => d.label === "onomatopoeia");
  let previousCount: number;
  do {
    previousCount = effects.length;
    const merged: MaskedDetection[] = [];
    for (const effect of effects.sort((a, b) => b.score - a.score)) {
      const target = merged.find((other) => {
        const { iou, nested } = overlap(other.box, effect.box);
        if (iou < 0.5 && nested < 0.8) return false;
        const a = other.mask.logits,
          b = effect.mask.logits;
        let both = 0,
          left = 0,
          right = 0;
        for (let i = 0; i < a.length; i++) {
          if (a[i] > 0) left++;
          if (b[i] > 0) right++;
          if (a[i] > 0 && b[i] > 0) both++;
        }
        return both > 0 && both >= Math.min(left, right) / 2;
      });
      if (!target) {
        merged.push(effect);
        continue;
      }
      const a = target.box,
        b = effect.box;
      target.score =
        (target.score * boxArea(a) + effect.score * boxArea(b)) /
        (boxArea(a) + boxArea(b));
      target.box = [
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        Math.max(a[2], b[2]),
        Math.max(a[3], b[3]),
      ];
      const mask = target.mask.logits,
        addition = effect.mask.logits;
      for (let i = 0; i < mask.length; i++)
        mask[i] = Math.max(mask[i], addition[i]);
    }
    effects = merged;
  } while (effects.length < previousCount);
  return [
    ...detections.filter((d) => d.label !== "onomatopoeia"),
    ...effects,
  ].sort((a, b) => b.score - a.score);
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
  const side = Math.max(imageSize.width, imageSize.height);
  const box: ComicDetectionBox = [
    clamp((centerX - width / 2) * side, 0, imageSize.width),
    clamp((centerY - height / 2) * side, 0, imageSize.height),
    clamp((centerX + width / 2) * side, 0, imageSize.width),
    clamp((centerY + height / 2) * side, 0, imageSize.height),
  ];
  return box[2] > box[0] && box[3] > box[1] ? box : null;
}

function copyInstanceMask(
  masks: KoharuTensorLike,
  index: number,
  imageSize: { width: number; height: number },
): NonNullable<ComicPageDetection["mask"]> {
  const size = KOHARU_LAYOUT_MASK_SIZE;
  const scale = size / Math.max(imageSize.width, imageSize.height);
  const extentX = imageSize.width * scale,
    extentY = imageSize.height * scale;
  const width = Math.max(1, Math.round(extentX)),
    height = Math.max(1, Math.round(extentY));
  const offset = index * size * size;
  const logits = new Float32Array(width * height);
  // Consumers work in a page-normalized grid. Remove letterbox padding and
  // align cell centres when the page ends between two native mask columns.
  for (let y = 0; y < height; y++) {
    const sy = Math.max(0, ((y + 0.5) * extentY) / height - 0.5);
    const top = Math.floor(sy),
      bottom = Math.min(size - 1, top + 1);
    const fy = sy - top;
    for (let x = 0; x < width; x++) {
      const sx = Math.max(0, ((x + 0.5) * extentX) / width - 0.5);
      const left = Math.floor(sx),
        right = Math.min(size - 1, left + 1);
      const fx = sx - left;
      const row = offset + top * size,
        next = offset + bottom * size;
      const value =
        (Number(masks.data[row + left]) * (1 - fx) +
          Number(masks.data[row + right]) * fx) *
          (1 - fy) +
        (Number(masks.data[next + left]) * (1 - fx) +
          Number(masks.data[next + right]) * fx) *
          fy;
      if (!Number.isFinite(value))
        throw new Error(
          "KoharuLayout masks 출력에 유한하지 않은 값이 있습니다.",
        );
      logits[y * width + x] = value;
    }
  }
  return { logits, width, height };
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
