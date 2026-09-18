import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

/** Only Electron's native image boundary is replaced. Raster masks, PNG artifacts,
 * native app processing and persistence remain production implementations. */
class Image {
  constructor(private readonly png: PNG | null) {}
  isEmpty() { return this.png === null; }
  getSize() { return { width: this.png?.width ?? 0, height: this.png?.height ?? 0 }; }
  toPNG() {
    if (!this.png) return Buffer.alloc(0);
    return PNG.sync.write(this.png);
  }
  toBitmap() {
    if (!this.png) return Buffer.alloc(0);
    return swapped(this.png.data);
  }
  resize(size: { width: number; height: number }) {
    if (!this.png) return new Image(null);
    const next = new PNG(size);
    for (let y = 0; y < size.height; y++)
      for (let x = 0; x < size.width; x++) {
        const sx = Math.min(this.png.width - 1, Math.floor(x * this.png.width / size.width));
        const sy = Math.min(this.png.height - 1, Math.floor(y * this.png.height / size.height));
        this.png.data.copy(next.data, (y * size.width + x) * 4,
          (sy * this.png.width + sx) * 4, (sy * this.png.width + sx) * 4 + 4);
      }
    return new Image(next);
  }
  crop(rect: { x: number; y: number; width: number; height: number }) {
    if (!this.png) return new Image(null);
    const next = new PNG({ width: rect.width, height: rect.height });
    PNG.bitblt(this.png, next, rect.x, rect.y, rect.width, rect.height, 0, 0);
    return new Image(next);
  }
}
function swapped(data: Buffer) {
  const next = Buffer.from(data);
  for (let i = 0; i < next.length; i += 4) {
    next[i] = data[i + 2]; next[i + 2] = data[i];
  }
  return next;
}
export const imageNativeBoundary = {
  createFromPath: (path: string) => {
    try { return new Image(PNG.sync.read(readFileSync(path))); }
    catch (_error) { return new Image(null); } // Native API represents decode failure as an empty image.
  },
  createFromBuffer: (bytes: Buffer) => {
    try { return new Image(PNG.sync.read(bytes)); }
    catch (_error) { return new Image(null); }
  },
  createFromBitmap: (bitmap: Buffer, size: { width: number; height: number }) => {
    const png = new PNG(size); png.data = swapped(bitmap); return new Image(png);
  },
};
