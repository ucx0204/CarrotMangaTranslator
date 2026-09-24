import { PNG } from "pngjs";

export function nativePng(bytes: Buffer) {
  const png = PNG.sync.read(bytes);
  return {
    isEmpty: () => false,
    getSize: () => ({ width: png.width, height: png.height }),
    toPNG: () => PNG.sync.write(png),
    crop: (rect: { x: number; y: number; width: number; height: number }) => {
      const target = new PNG({ width: rect.width, height: rect.height });
      PNG.bitblt(png, target, rect.x, rect.y, rect.width, rect.height, 0, 0);
      return nativePng(PNG.sync.write(target));
    },
  };
}
