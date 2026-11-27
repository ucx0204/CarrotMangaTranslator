import { makeBlock } from "./unifiedInpaintingUiFixtures";
import { expect } from "vitest";
import { PNG } from "pngjs";

/** Native-image boundary double; the real Electron decoder is also exercised by the local smoke. */
export class Raster {
  constructor(
    readonly data: Buffer,
    readonly width: number,
    readonly height: number,
  ) {}
  isEmpty() {
    return false;
  }
  toBitmap() {
    return Buffer.from(this.data);
  }
  toPNG() {
    const png = new PNG({ width: this.width, height: this.height });
    png.data = this.data;
    return PNG.sync.write(png);
  }
  toDataURL() {
    return `data:image/png;base64,${this.toPNG().toString("base64")}`;
  }
  getSize() {
    return { width: this.width, height: this.height };
  }
  resize(size: { width: number; height: number }) {
    const data = Buffer.alloc(size.width * size.height * 4);
    for (let y = 0; y < size.height; y++)
      for (let x = 0; x < size.width; x++) {
        const offset =
          (Math.floor((y * this.height) / size.height) * this.width +
            Math.floor((x * this.width) / size.width)) *
          4;
        this.data.copy(data, (y * size.width + x) * 4, offset, offset + 4);
      }
    return new Raster(data, size.width, size.height);
  }
  crop(rect: { x: number; y: number; width: number; height: number }) {
    expect(rect.x + rect.width).toBeLessThanOrEqual(this.width);
    expect(rect.y + rect.height).toBeLessThanOrEqual(this.height);
    const data = Buffer.alloc(rect.width * rect.height * 4);
    for (let y = 0; y < rect.height; y++) {
      const start = ((y + rect.y) * this.width + rect.x) * 4;
      this.data.copy(data, y * rect.width * 4, start, start + rect.width * 4);
    }
    return new Raster(data, rect.width, rect.height);
  }
}

export function reportedRepairImages(factor: number) {
  const width = 131,
    height = 231;
  const window = { x: 45, y: 45, w: 45, h: 141 };
  const mask = new Uint8Array(width * height);
  const artwork = new PNG({ width, height });
  const ink = new PNG({ width, height });
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const paper = Math.round(
        160 + 47 * Math.sin(x / 7 + y / 13) + 32 * Math.cos(y / 9 - x / 8),
      );
      artwork.data.fill(paper, i * 4, i * 4 + 3);
      artwork.data[i * 4 + 3] = ink.data[i * 4 + 3] = 255;
      if (
        x >= window.x &&
        x < window.x + window.w &&
        y >= window.y &&
        y < window.y + window.h
      )
        mask[i] = 1;
      const glyph = x >= 57 && x < 70 && y >= 70 && y < 155;
      ink.data.fill(glyph ? 10 : paper, i * 4, i * 4 + 3);
    }
  const generated = new PNG({ width: 1208, height: 1302 });
  generated.data.fill(255);
  const contentWidth = Math.round(
    Math.round((width * generated.height) / height) * factor,
  );
  // Nearest pixel centers preserve this known background under enlargement.
  for (let y = 0; y < generated.height; y++)
    for (let x = 0; x < contentWidth; x++) {
      const from =
        (Math.floor(((y + 0.5) * height) / generated.height) * width +
          Math.floor(((x + 0.5) * width) / contentWidth)) *
        4;
      artwork.data.copy(
        generated.data,
        (y * generated.width + x) * 4,
        from,
        from + 4,
      );
    }
  return { width, height, window, mask, artwork, ink, generated, contentWidth };
}

export function independentBlockImages() {
  const width = 520,
    height = 180;
  const windows = [
    { x: 40, y: 30, w: 20, h: 20 },
    { x: 40, y: 81, w: 430, h: 18 },
    { x: 460, y: 140, w: 20, h: 20 },
  ];
  const source = new PNG({ width, height });
  source.data.fill(255);
  const blocks = windows.map(({ x, y, w, h }, i) => {
    for (let row = y; row < y + h; row++)
      for (let col = x; col < x + w; col++) {
        const at = (row * width + col) * 4;
        source.data.fill(10, at, at + 3);
      }
    return {
      ...makeBlock(),
      id: String(i),
      bbox: {
        x: (1000 * x) / width,
        y: (1000 * y) / height,
        w: (1000 * w) / width,
        h: (1000 * h) / height,
      },
    };
  });
  return { width, height, source, blocks };
}
