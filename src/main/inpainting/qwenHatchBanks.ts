type Raster = {
  gray: Uint8Array;
  clean: Uint8Array;
  obstacle: Uint8Array;
  width: number;
  height: number;
};

function linearCoverage(
  plane: Uint8Array,
  i: number,
  x: number,
  y: number,
  stride: number,
) {
  return (
    (1 - y) * ((1 - x) * plane[i] + x * plane[i + 1]) +
    y * ((1 - x) * plane[i + stride] + x * plane[i + stride + 1])
  );
}

function cubic(a: number, b: number, c: number, d: number, x: number) {
  return (
    b +
    0.5 *
      x *
      (c - a + x * (2 * a - 5 * b + 4 * c - d + x * (3 * (b - c) + d - a)))
  );
}

function toneAt(
  plane: Uint8Array,
  i: number,
  x: number,
  y: number,
  stride: number,
) {
  const row = (at: number) =>
    cubic(plane[at - 1], plane[at], plane[at + 1], plane[at + 2], x);
  return Math.max(
    0,
    Math.min(
      255,
      cubic(row(i - stride), row(i), row(i + stride), row(i + 2 * stride), y),
    ),
  );
}

function mean() {
  let sum = 0,
    weight = 0;
  return {
    add(value: number, w: number) {
      sum += w * value;
      weight += w;
    },
    value(minimum: number) {
      return weight > minimum ? sum / weight : undefined;
    },
  };
}

const gaussian = (x: number) => Math.exp(-x * x);

/** Read along the pen without crossing a solid frame or an unrelated contour.
 * The short and long averages measure the local slope and the grain of the ink. */
function readBank(
  raster: Raster,
  x: number,
  y: number,
  dx: number,
  dy: number,
) {
  const { gray, clean, obstacle, width, height } = raster;
  const near = mean(),
    far = mean(),
    grain = mean(),
    stock = mean();
  let first = 0,
    blocked = 0;
  for (let distance = 1; distance <= 110; distance++) {
    const px = x + distance * dx,
      py = y + distance * dy;
    const left = Math.floor(px),
      top = Math.floor(py);
    if (left < 1 || top < 1 || left >= width - 2 || top >= height - 2) break;
    const i = top * width + left,
      fx = px - left,
      fy = py - top;
    if (linearCoverage(obstacle, i, fx, fy, width) > 0.72 && ++blocked >= 4)
      break;
    if (linearCoverage(clean, i, fx, fy, width) <= 0.96) continue;
    first ||= distance;
    const delta = distance - first;
    if (delta > 28) break;
    const level = toneAt(gray, i, fx, fy, width);
    near.add(level, gaussian(delta / 2.6));
    if (delta >= 5) far.add(level, gaussian((delta - 5) / 3.15));
    const offset = delta - Math.min(18, first);
    grain.add(level, gaussian(offset / (0.9 * Math.SQRT2)));
    stock.add(level, gaussian(offset / (3.3 * Math.SQRT2)));
  }
  return summarizeBank(first, near, far, grain, stock);
}

function summarizeBank(
  first: number,
  near: ReturnType<typeof mean>,
  far: ReturnType<typeof mean>,
  grain: ReturnType<typeof mean>,
  stock: ReturnType<typeof mean>,
) {
  const level = near.value(1.1);
  if (level === undefined) return;
  const background = stock.value(0) ?? level;
  const variation = (grain.value(0.7) ?? background) - background;
  const slope = (level - (far.value(1.5) ?? level)) / 5.5;
  return {
    first,
    level,
    slope: Math.max(-4.5, Math.min(4.5, slope)),
    grain: Math.max(-23, Math.min(23, variation)),
  };
}

/** Monotone cubic Hermite interpolation preserves taper without introducing
 * an overshoot darker than either visible end of the stroke. */
export function hatchBankSampler(raster: Raster, angle: number) {
  const dx = Math.cos(angle),
    dy = Math.sin(angle);
  return (x: number, y: number) => {
    const left = readBank(raster, x, y, -dx, -dy),
      right = readBank(raster, x, y, dx, dy);
    if (!left || !right) {
      const end = left ?? right;
      return end && end.level + 0.65 * end.grain;
    }
    const gap = left.first + right.first,
      t = left.first / gap;
    const gradient = (right.level - left.level) / gap;
    const sign = Math.sign(gradient);
    const limited = (slope: number) =>
      sign * Math.min(3 * Math.abs(gradient), Math.max(0, slope * sign));
    const eased = t * t * (3 - 2 * t);
    return (
      (1 - eased) * left.level +
      eased * right.level +
      t *
        (1 - t) *
        gap *
        ((1 - t) * limited(left.slope) - t * limited(-right.slope)) +
      0.65 * ((1 - t) * left.grain + t * right.grain)
    );
  };
}
