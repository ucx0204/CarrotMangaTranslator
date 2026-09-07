type GrayRaster = { width: number; height: number; data: Float32Array };
type Offset = { dx: number; dy: number };
type ContextSample = { x: number; y: number; value: number; weight: number };
type Candidate = (x: number, y: number, dx: number, dy: number) => number;

export type TypesettingSeamWarp = {
  spacing: number;
  columns: number;
  rows: number;
  offsets: (Offset | null)[];
};

/** Fit only preserved context beside the splice; source lettering never enters the fit. */
export function registerTypesettingSeams(
  source: GrayRaster,
  permission: Uint8Array,
  candidate: Candidate,
): TypesettingSeamWarp | undefined {
  const spacing = Math.max(24, Math.ceil(Math.sqrt(source.data.length / 256)));
  const columns = Math.ceil((source.width - 1) / spacing) + 1;
  const rows = Math.ceil((source.height - 1) / spacing) + 1;
  const offsets: (Offset | null)[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const samples = seamContext(
        source,
        permission,
        column * spacing,
        row * spacing,
      );
      offsets.push(fitSeam(samples, candidate));
    }
  }
  if (!offsets.some((offset) => offset && (offset.dx || offset.dy)))
    return undefined;
  return { spacing, columns, rows, offsets };
}

function seamContext(
  source: GrayRaster,
  permission: Uint8Array,
  cx: number,
  cy: number,
): ContextSample[] {
  const samples: ContextSample[] = [];
  let masked = 0;
  for (
    let y = Math.max(2, cy - 16);
    y <= Math.min(source.height - 3, cy + 16);
    y += 2
  ) {
    for (
      let x = Math.max(2, cx - 16);
      x <= Math.min(source.width - 3, cx + 16);
      x += 2
    ) {
      const at = y * source.width + x;
      if (permission[at]) {
        masked++;
        continue;
      }
      if (
        [-1, 1, -source.width, source.width].some(
          (offset) => permission[at + offset],
        )
      )
        continue;
      const gradient =
        Math.abs(source.data[at + 1] - source.data[at - 1]) +
        Math.abs(
          source.data[at + source.width] - source.data[at - source.width],
        );
      samples.push({
        x,
        y,
        value: source.data[at],
        weight: 1 + 6 * Math.min(1, gradient),
      });
    }
  }
  // Blank or fully masked tiles provide no evidence of a displacement.
  return masked > 0 && samples.length >= 48 ? samples : [];
}

function fitSeam(
  samples: ContextSample[],
  candidate: Candidate,
): Offset | null {
  const zero = { dx: 0, dy: 0 };
  if (!samples.length) return null;
  const values = samples.map((sample) => sample.value);
  if (Math.max(...values) - Math.min(...values) < 0.25) return null;
  const before = seamError(samples, candidate, zero);
  if (before < 0.005) return zero;
  let best = { offset: zero, error: before };
  for (const step of [1, 0.25]) {
    best = searchSeam(samples, candidate, best, step);
  }
  return best.error < before * 0.8 && before - best.error > 0.003
    ? best.offset
    : before < 0.015
      ? zero
      : null;
}

function searchSeam(
  samples: ContextSample[],
  candidate: Candidate,
  initial: { offset: Offset; error: number },
  step: number,
) {
  let best = initial;
  const center = initial.offset;
  const radius = step === 1 ? 6 : 3;
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      const offset = { dx: center.dx + x * step, dy: center.dy + y * step };
      if (Math.hypot(offset.dx, offset.dy) > 6) continue;
      const error = seamError(samples, candidate, offset);
      if (error < best.error) best = { offset, error };
    }
  }
  return best;
}

function seamError(
  samples: ContextSample[],
  candidate: Candidate,
  offset: Offset,
): number {
  let error = 0;
  let weights = 0;
  for (const sample of samples) {
    error +=
      sample.weight *
      Math.abs(
        candidate(sample.x, sample.y, offset.dx, offset.dy) - sample.value,
      );
    weights += sample.weight;
  }
  // Prefer the smallest motion along ambiguous straight lines or repeating tone.
  return error / weights + 0.0004 * (offset.dx ** 2 + offset.dy ** 2);
}

export function typesettingSeamOffset(
  warp: TypesettingSeamWarp,
  x: number,
  y: number,
): Offset {
  const column = Math.min(
    warp.columns - 2,
    Math.max(0, Math.floor(x / warp.spacing)),
  );
  const row = Math.min(
    warp.rows - 2,
    Math.max(0, Math.floor(y / warp.spacing)),
  );
  const fx = Math.min(1, Math.max(0, x / warp.spacing - column));
  const fy = Math.min(1, Math.max(0, y / warp.spacing - row));
  const offset = { dx: 0, dy: 0 };
  let weights = 0;
  for (let corner = 0; corner < 4; corner++) {
    const right = corner % 2,
      bottom = Math.floor(corner / 2);
    const weight = (right ? fx : 1 - fx) * (bottom ? fy : 1 - fy);
    const value = warp.offsets[(row + bottom) * warp.columns + column + right];
    if (!value) continue;
    offset.dx += value.dx * weight;
    offset.dy += value.dy * weight;
    weights += weight;
  }
  offset.dx /= Math.max(0.25, weights);
  offset.dy /= Math.max(0.25, weights);
  return offset;
}
