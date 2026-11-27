export class PoissonConvergenceError extends Error {}

/** Sparse geometric multigrid. Missing cells are Dirichlet boundaries, never tile edges. */
type Level = {
  positions: Int32Array;
  neighbors: Int32Array;
  order: Int32Array;
  redCount: number;
  solved?: boolean;
  values: Float32Array;
  rhs: Float32Array;
  width: number;
  coarse?: Level;
  children?: Int32Array;
  parents?: Int32Array;
};

export function createPoissonDomain(
  positions: Int32Array,
  width: number,
): Level {
  const n = positions.length;
  const indices = createDomainIndex(positions, width);
  const neighbors = new Int32Array(n * 4).fill(-1);
  positions.forEach((p, i) => {
    const x = p % width;
    neighbors[i * 4] = x > 0 ? (indices.get(p - 1) ?? -1) : -1;
    neighbors[i * 4 + 1] = x + 1 < width ? (indices.get(p + 1) ?? -1) : -1;
    neighbors[i * 4 + 2] = indices.get(p - width) ?? -1;
    neighbors[i * 4 + 3] = indices.get(p + width) ?? -1;
  });
  const parity = Uint8Array.from(
    positions,
    (p) => ((p % width) + Math.floor(p / width)) & 1,
  );
  const order = new Int32Array(n);
  let redCount = 0;
  for (let i = 0; i < n; i++) if (parity[i] === 0) order[redCount++] = i;
  let cursor = redCount;
  for (let i = 0; i < n; i++) if (parity[i] === 1) order[cursor++] = i;
  const level: Level = {
    positions,
    neighbors,
    order,
    redCount,
    width,
    values: new Float32Array(n),
    rhs: new Float32Array(n),
  };
  if (n < 64 || width < 4) return level;
  const coarseWidth = Math.ceil(width / 2);
  const coarsePositions: number[] = [];
  const children: number[] = [];
  positions.forEach((p, i) => {
    const x = p % width;
    const y = Math.floor(p / width);
    if (x % 2 || y % 2 || x + 1 >= width) return;
    const right = indices.get(p + 1);
    const down = indices.get(p + width);
    const diagonal = indices.get(p + width + 1);
    if (right === undefined || down === undefined || diagonal === undefined)
      return;
    coarsePositions.push((y / 2) * coarseWidth + x / 2);
    children.push(i, right, down, diagonal);
  });
  if (!coarsePositions.length) return level;
  level.children = Int32Array.from(children);
  const parents = new Int32Array(n).fill(-1);
  level.parents = parents;
  children.forEach((child, i) => {
    parents[child] = Math.floor(i / 4);
  });
  level.coarse = createPoissonDomain(
    Int32Array.from(coarsePositions),
    coarseWidth,
  );
  return level;
}

function smooth(level: Level, count: number, check: () => void): void {
  for (let sweep = 0; sweep < count; sweep++) {
    check();
    smoothParity(level, 0);
    smoothParity(level, 1);
  }
}

function smoothParity(level: Level, parity: number): void {
  const { neighbors, rhs, values } = level;
  const end = parity === 0 ? level.redCount : values.length;
  for (let k = parity === 0 ? 0 : level.redCount; k < end; k++) {
    const i = level.order[k];
    const o = i * 4;
    const a = neighbors[o],
      b = neighbors[o + 1],
      c = neighbors[o + 2],
      d = neighbors[o + 3];
    const sum =
      rhs[i] +
      (a < 0 ? 0 : values[a]) +
      (b < 0 ? 0 : values[b]) +
      (c < 0 ? 0 : values[c]) +
      (d < 0 ? 0 : values[d]);
    values[i] += 1.2 * (sum * 0.25 - values[i]);
  }
}

function residual(level: Level, i: number): number {
  const o = i * 4,
    { neighbors, values } = level;
  const a = neighbors[o],
    b = neighbors[o + 1],
    c = neighbors[o + 2],
    d = neighbors[o + 3];
  return (
    level.rhs[i] -
    4 * values[i] +
    (a < 0 ? 0 : values[a]) +
    (b < 0 ? 0 : values[b]) +
    (c < 0 ? 0 : values[c]) +
    (d < 0 ? 0 : values[d])
  );
}

function cycle(level: Level, check: () => void): void {
  if (!level.coarse || !level.children || !level.parents) {
    smooth(level, 40, check);
    return;
  }
  smooth(level, 3, check);
  const coarse = level.coarse;
  coarse.values.fill(0);
  for (let c = 0; c < coarse.values.length; c++) {
    let sum = 0;
    for (let k = 0; k < 4; k++)
      sum += residual(level, level.children[c * 4 + k]);
    coarse.rhs[c] = sum;
  }
  cycle(coarse, check);
  for (let i = 0; i < level.values.length; i++) {
    const parent = level.parents[i];
    if (parent >= 0) level.values[i] += coarse.values[parent];
  }
  smooth(level, 3, check);
}

export function solvePoissonChannel(
  level: Level,
  boundary: (position: number) => number,
  check: () => void,
): Float32Array {
  const offsets = [-1, 1, -level.width, level.width];
  let identical = level.solved === true;
  const plane = new BoundaryPlane(level.width);
  for (let i = 0; i < level.values.length; i++) {
    const p = level.positions[i];
    let rhs = 0;
    for (let d = 0; d < 4; d++) {
      if (level.neighbors[i * 4 + d] < 0) {
        const value = boundary(p + offsets[d]);
        rhs += value;
        plane.add(p + offsets[d], value);
      }
    }
    if (level.rhs[i] !== Math.fround(rhs)) identical = false;
    level.rhs[i] = rhs;
  }
  if (identical) return level.values;
  plane.initialize(level.positions, level.values);
  for (let iteration = 0; iteration < 80; iteration++) {
    let error = 0;
    for (let i = 0; i < level.values.length; i++)
      error = Math.max(error, Math.abs(residual(level, i)));
    if (error < 2e-5) {
      level.solved = true;
      return level.values;
    }
    cycle(level, check);
  }
  throw new PoissonConvergenceError(
    "치유 계산이 수렴하지 않았습니다. 더 작은 영역으로 다시 시도해 주세요.",
  );
}

/** An affine initial guess removes large brightness ramps without changing the solution. */
class BoundaryPlane {
  private readonly matrix = Array.from(
    { length: 3 },
    () => new Float64Array(4),
  );
  constructor(private readonly width: number) {}
  add(p: number, value: number): void {
    const basis = [
      1,
      (p % this.width) / this.width,
      Math.floor(p / this.width) / this.width,
    ];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) this.matrix[i][j] += basis[i] * basis[j];
      this.matrix[i][3] += basis[i] * value;
    }
  }
  initialize(positions: Int32Array, values: Float32Array): void {
    const m = this.matrix;
    const mean = m[0][0] ? m[0][3] / m[0][0] : 0;
    for (let i = 0; i < 3; i++) {
      const pivot = m[i][i];
      if (Math.abs(pivot) < 1e-10) {
        values.fill(mean);
        return;
      }
      for (let j = i; j < 4; j++) m[i][j] /= pivot;
      this.eliminate(i);
    }
    for (let i = 0; i < values.length; i++) {
      const p = positions[i];
      values[i] =
        m[0][3] +
        (m[1][3] * (p % this.width)) / this.width +
        (m[2][3] * Math.floor(p / this.width)) / this.width;
    }
  }
  private eliminate(i: number): void {
    const m = this.matrix;
    for (let k = 0; k < 3; k++) {
      if (k === i) continue;
      const factor = m[k][i];
      for (let j = i; j < 4; j++) m[k][j] -= factor * m[i][j];
    }
  }
}

function createDomainIndex(
  positions: Int32Array,
  width: number,
): { get(p: number): number | undefined } {
  let left = width,
    right = 0,
    top = Infinity,
    bottom = 0;
  for (const p of positions) {
    const x = p % width,
      y = Math.floor(p / width);
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  const columns = right - left + 1,
    rows = bottom - top + 1;
  // Compact regions use a bounded lookup array. Long diagonals retain sparse maps.
  if (columns * rows > positions.length * 2 || !positions.length) {
    const sparse = new Map<number, number>();
    positions.forEach((p, i) => sparse.set(p, i));
    return sparse;
  }
  const dense = new Int32Array(columns * rows);
  positions.forEach((p, i) => {
    dense[(Math.floor(p / width) - top) * columns + (p % width) - left] = i + 1;
  });
  return {
    get(p) {
      const x = (p % width) - left,
        y = Math.floor(p / width) - top;
      if (x < 0 || x >= columns || y < 0 || y >= rows) return undefined;
      const index = dense[y * columns + x];
      return index ? index - 1 : undefined;
    },
  };
}
