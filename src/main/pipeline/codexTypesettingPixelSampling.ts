export type Raster = { width: number; height: number; data: Uint8Array };
export type GrayRaster = { width: number; height: number; data: Float32Array };

export function smooth(image: GrayRaster): GrayRaster {
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

export function grayscale(image: Raster): GrayRaster {
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

export function sampleGray(image: GrayRaster, x: number, y: number): number {
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

export function sampleChannel(
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
