import { PNG } from "pngjs";

export function nativePng(bytes: Buffer) {
  return rasterImage(PNG.sync.read(bytes));
}

function rasterImage(png: PNG) {
  let encoded: Buffer | undefined;
  return {
    isEmpty: () => false,
    getSize: () => ({ width: png.width, height: png.height }),
    toPNG: () => Buffer.from((encoded ??= PNG.sync.write(png))),
    crop: (rect: { x: number; y: number; width: number; height: number }) => {
      const target = new PNG({ width: rect.width, height: rect.height });
      PNG.bitblt(png, target, rect.x, rect.y, rect.width, rect.height, 0, 0);
      return rasterImage(target);
    },
  };
}
