import type { PixelRect } from "../../shared/region";

type Raster = { width: number; height: number; data: Uint8Array };
type Transform = { dx: number; dy: number; scale: number };
type Sample = { x: number; y: number; value: number; weight: number };
type GrayRaster = { width: number; height: number; data: Float32Array };

/** Experimental gate: geometric agreement is necessary, not a semantic quality score. */
export function registerTypesettingPatch(
  source: Raster,
  generated: Raster,
  erase: PixelRect,
  permission?: Uint8Array,
) {
  validateRegistrationInputs(source, generated, permission);
  const original = grayscale(source);
  const candidate = grayscale(generated);
  const samples = contextSamples(original, erase);
  const fitSamples = contextSamples(smooth(original), erase);
  const fitCandidate = smooth(candidate);
  const identity = { dx: 0, dy: 0, scale: 1 };
  const before = sampleError(candidate, samples, identity);
  let transform = identity;
  let error = sampleError(fitCandidate, fitSamples, identity);
  for (const step of [2, 0.5, 0.125]) {
    const result = searchTransform(
      fitCandidate,
      fitSamples,
      transform,
      step,
      erase,
    );
    if (result.error < error) ({ transform, error } = result);
  }
  error = sampleError(candidate, samples, transform);
  const boundary = boundaryErrors(candidate, original, erase, transform);
  const maskBoundary = permission
    ? permissionBoundaryErrors(candidate, original, permission, transform)
    : null;
  const enoughContext = samples.length >= 32;
  const supported = supportsErase(candidate, erase, transform);
  const opaque = opaqueBackground(generated, erase, transform);
  const accepted =
    enoughContext &&
    supported &&
    opaque &&
    error <= 0.06 &&
    boundary.worst <= 0.12 &&
    permissionBoundaryAccepted(maskBoundary);
  return {
    accepted,
    transform,
    contextErrorBefore: before,
    contextErrorAfter: error,
    boundary,
    maskBoundary,
    samples: samples.length,
    supported,
    opaque,
    reason: registrationReason(enoughContext, supported && opaque, accepted),
  };
}

function validateRegistrationInputs(
  source: Raster,
  generated: Raster,
  permission?: Uint8Array,
): void {
  if (source.width !== generated.width || source.height !== generated.height)
    throw new Error("합성 정합 입력의 해상도가 다릅니다.");
  if (permission && permission.length !== source.width * source.height)
    throw new Error("합성 허용 마스크의 해상도가 다릅니다.");
}

function permissionBoundaryAccepted(
  boundary: ReturnType<typeof permissionBoundaryErrors> | null,
): boolean {
  return (
    !boundary ||
    (boundary.samples > 0 && boundary.mean <= 0.06 && boundary.worst <= 0.12)
  );
}

/** Test preserved pixels at the actual splice, including holes inside its bbox. */
function permissionBoundaryErrors(
  generated: GrayRaster,
  source: GrayRaster,
  permission: Uint8Array,
  transform: Transform,
) {
  const groups = new Map<string, Sample[]>();
  for (let y = 1; y < source.height - 1; y++) {
    for (let x = 1; x < source.width - 1; x++) {
      const at = y * source.width + x;
      if (
        permission[at] ||
        ![-1, 1, -source.width, source.width].some(
          (offset) => permission[at + offset],
        )
      )
        continue;
      const key = `${Math.floor(x / 16)}:${Math.floor(y / 16)}`;
      const group = groups.get(key) ?? [];
      group.push(makeSample(source, x, y));
      groups.set(key, group);
    }
  }
  const all = [...groups.values()].flat();
  return {
    samples: all.length,
    mean: sampleError(generated, all, transform),
    worst: Math.max(
      0,
      ...[...groups.values()].map((group) =>
        sampleError(generated, group, transform),
      ),
    ),
  };
}

function registrationReason(
  context: boolean,
  coverage: boolean,
  accepted: boolean,
): string {
  if (!context) return "정합을 검증할 주변 문맥이 부족합니다.";
  if (!coverage)
    return "생성 배경이 제거 영역 전체를 불투명하게 덮지 못합니다.";
  return accepted
    ? "주변 문맥과 합성 경계의 기하 검사 통과; 시각 검수는 별도입니다."
    : "생성 배경과 원본의 선·명암 경계가 맞지 않습니다.";
}

function smooth(image: GrayRaster): GrayRaster {
  const data = new Float32Array(image.data);
  for (let y = 1; y < image.height - 1; y++) {
    for (let x = 1; x < image.width - 1; x++) {
      const at = y * image.width + x;
      data[at] = smoothedValue(image, at);
    }
  }
  return { ...image, data };
}

function smoothedValue(image: GrayRaster, at: number): number {
  let value = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      value +=
        image.data[at + dy * image.width + dx] *
        (dx === 0 ? 2 : 1) *
        (dy === 0 ? 2 : 1);
    }
  }
  return value / 16;
}

function supportsErase(
  image: GrayRaster,
  erase: PixelRect,
  transform: Transform,
): boolean {
  const start = transformedPoint(image, erase.x, erase.y, transform);
  const end = transformedPoint(
    image,
    erase.x + erase.w - 1,
    erase.y + erase.h - 1,
    transform,
  );
  return (
    start.x >= 0 && start.y >= 0 && end.x < image.width && end.y < image.height
  );
}

function opaqueBackground(
  image: Raster,
  erase: PixelRect,
  transform: Transform,
): boolean {
  for (let y = erase.y; y < erase.y + erase.h; y++) {
    for (let x = erase.x; x < erase.x + erase.w; x++) {
      const point = transformedPoint(image, x, y, transform);
      if (sampleChannel(image, point.x, point.y, 3) < 254.5) return false;
    }
  }
  return true;
}

/** Samples generated coordinates; never modifies the input or pixels outside erase. */
export function compositeRegisteredPatch(
  base: Raster,
  generated: Raster,
  erase: PixelRect,
  offset: { x: number; y: number },
  transform: Transform,
  permission?: Uint8Array,
  blendOpacity?: Float64Array,
): void {
  if (
    blendOpacity &&
    blendOpacity.length !== generated.width * generated.height
  )
    throw new Error("배경 접합 alpha의 해상도가 다릅니다.");
  for (let y = erase.y; y < erase.y + erase.h; y++) {
    for (let x = erase.x; x < erase.x + erase.w; x++) {
      if (permission && !permission[y * generated.width + x]) continue;
      const point = transformedPoint(generated, x, y, transform);
      const destination = ((y + offset.y) * base.width + x + offset.x) * 4;
      const alpha = blendOpacity?.[y * generated.width + x] ?? 1;
      for (let channel = 0; channel < 4; channel++) {
        base.data[destination + channel] = Math.round(
          sampleChannel(generated, point.x, point.y, channel) * alpha +
            base.data[destination + channel] * (1 - alpha),
        );
      }
    }
  }
}

function grayscale(image: Raster): GrayRaster {
  const data = new Float32Array(image.width * image.height);
  for (let index = 0; index < data.length; index++) {
    const from = index * 4;
    data[index] =
      (image.data[from] * 0.2126 +
        image.data[from + 1] * 0.7152 +
        image.data[from + 2] * 0.0722) /
      255;
  }
  return { width: image.width, height: image.height, data };
}

function contextSamples(image: GrayRaster, erase: PixelRect): Sample[] {
  const samples: Sample[] = [];
  const stride = Math.max(
    1,
    Math.ceil(Math.sqrt((image.width * image.height) / 6000)),
  );
  for (let y = 2; y < image.height - 2; y += stride) {
    for (let x = 2; x < image.width - 2; x += stride) {
      if (inside(x, y, erase, 4)) continue;
      samples.push(makeSample(image, x, y));
    }
  }
  return samples;
}

function makeSample(image: GrayRaster, x: number, y: number): Sample {
  const at = y * image.width + x;
  const gradient =
    Math.abs(image.data[at + 1] - image.data[at - 1]) +
    Math.abs(image.data[at + image.width] - image.data[at - image.width]);
  return { x, y, value: image.data[at], weight: 1 + 6 * Math.min(1, gradient) };
}

function searchTransform(
  image: GrayRaster,
  samples: Sample[],
  initial: Transform,
  step: number,
  erase: PixelRect,
) {
  let transform = initial;
  let error = sampleError(image, samples, initial);
  const radius = step === 2 ? 5 : 3;
  for (let scale = -2; scale <= 2; scale++) {
    for (let position = 0; position < (radius * 2 + 1) ** 2; position++) {
      const x = (position % (radius * 2 + 1)) - radius;
      const y = Math.floor(position / (radius * 2 + 1)) - radius;
      const proposal = {
        dx: initial.dx + x * step,
        dy: initial.dy + y * step,
        scale: initial.scale + scale * step * 0.01,
      };
      // A better context score must never expose original glyphs at a clipped edge.
      if (!supportsErase(image, erase, proposal)) continue;
      const next = sampleError(image, samples, proposal);
      if (next < error) {
        error = next;
        transform = proposal;
      }
    }
  }
  return { transform, error };
}

function sampleError(
  image: GrayRaster,
  samples: Sample[],
  transform: Transform,
) {
  let total = 0;
  let weights = 0;
  for (const sample of samples) {
    const { x, y } = transformedPoint(image, sample.x, sample.y, transform);
    const value = sampleGray(image, x, y);
    total += sample.weight * Math.abs(value - sample.value);
    weights += sample.weight;
  }
  return weights ? total / weights : 1;
}

function boundaryErrors(
  generated: GrayRaster,
  source: GrayRaster,
  erase: PixelRect,
  transform: Transform,
) {
  const sides: Sample[][] = [[], [], [], []];
  for (
    let y = Math.max(2, erase.y - 5);
    y < Math.min(source.height - 2, erase.y + erase.h + 5);
    y++
  ) {
    for (
      let x = Math.max(2, erase.x - 5);
      x < Math.min(source.width - 2, erase.x + erase.w + 5);
      x++
    ) {
      if (inside(x, y, erase, 0)) continue;
      const side =
        x < erase.x ? 0 : x >= erase.x + erase.w ? 1 : y < erase.y ? 2 : 3;
      sides[side].push(makeSample(source, x, y));
    }
  }
  const errors = sides.map((samples) =>
    samples.length ? sampleError(generated, samples, transform) : null,
  );
  return {
    sides: errors,
    worst: Math.max(0, ...errors.filter((value) => value !== null)),
  };
}

function inside(
  x: number,
  y: number,
  rect: PixelRect,
  padding: number,
): boolean {
  return (
    x >= rect.x - padding &&
    x < rect.x + rect.w + padding &&
    y >= rect.y - padding &&
    y < rect.y + rect.h + padding
  );
}

function transformedPoint(
  image: { width: number; height: number },
  x: number,
  y: number,
  transform: Transform,
) {
  const cx = (image.width - 1) / 2;
  const cy = (image.height - 1) / 2;
  return {
    x: (x - cx) * transform.scale + cx + transform.dx,
    y: (y - cy) * transform.scale + cy + transform.dy,
  };
}

function sampleGray(image: GrayRaster, x: number, y: number): number {
  if (x < 0 || y < 0 || x > image.width - 1 || y > image.height - 1) return 0.5;
  const left = Math.floor(x);
  const top = Math.floor(y);
  const right = Math.min(left + 1, image.width - 1);
  const bottom = Math.min(top + 1, image.height - 1);
  const fx = x - left;
  const fy = y - top;
  return (
    (image.data[top * image.width + left] * (1 - fx) +
      image.data[top * image.width + right] * fx) *
      (1 - fy) +
    (image.data[bottom * image.width + left] * (1 - fx) +
      image.data[bottom * image.width + right] * fx) *
      fy
  );
}

function sampleChannel(
  image: Raster,
  x: number,
  y: number,
  channel: number,
): number {
  const left = Math.max(0, Math.min(image.width - 1, Math.floor(x)));
  const top = Math.max(0, Math.min(image.height - 1, Math.floor(y)));
  const right = Math.min(left + 1, image.width - 1);
  const bottom = Math.min(top + 1, image.height - 1);
  const fx = Math.max(0, Math.min(1, x - left));
  const fy = Math.max(0, Math.min(1, y - top));
  const at = (px: number, py: number) =>
    image.data[(py * image.width + px) * 4 + channel];
  return (
    (at(left, top) * (1 - fx) + at(right, top) * fx) * (1 - fy) +
    (at(left, bottom) * (1 - fx) + at(right, bottom) * fx) * fy
  );
}
