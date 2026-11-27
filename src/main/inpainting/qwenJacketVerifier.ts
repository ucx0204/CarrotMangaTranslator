import type { NativeImage } from "electron";
import { createQwenFloatProcess } from "./qwenFloatInference";
import { ensureQwenJacketVerifier } from "./qwenImageAssets";
import { maskComponents } from "./rasterMasks";
import type { PixelRect } from "./maskGeometry";

/** The original selection remains authoritative. Only revisit a line when a
 * text probability region survives in the same place on the edited jacket. */
export class QwenJacketVerifier {
  private readonly inference = createQwenFloatProcess();
  private weights?: Promise<string>;
  constructor(private readonly modelDir: string) {}

  async lines(image: NativeImage, signal: AbortSignal) {
    signal.throwIfAborted();
    this.weights ??= ensureQwenJacketVerifier({
      modelDir: this.modelDir,
      signal,
    }).catch((error: unknown) => {
      this.weights = undefined;
      throw error;
    });
    const modelPath = await this.weights;
    signal.throwIfAborted();
    const size = image.getSize(),
      scale = 960 / Math.max(size.width, size.height);
    const w = Math.max(32, 32 * Math.round((size.width * scale) / 32)),
      h = Math.max(32, 32 * Math.round((size.height * scale) / 32));
    const raster = image
      .resize({ width: w, height: h, quality: "best" })
      .toBitmap();
    const a = new Float32Array(3 * w * h),
      mean = [0.485, 0.456, 0.406],
      deviation = [0.229, 0.224, 0.225];
    for (let c = 0; c < 3; c++)
      for (let i = 0; i < w * h; i++)
        a[c * w * h + i] = (raster[i * 4 + c] / 255 - mean[c]) / deviation[c];
    const map = await this.inference.run(
      {
        modelPath,
        threads: 2,
        inputs: [{ data: a, dims: [1, 3, h, w] }],
      },
      signal,
    );
    signal.throwIfAborted();
    const dims = map.dims;
    if (
      dims.length !== 4 ||
      dims[0] !== 1 ||
      dims[1] !== 1 ||
      dims[2] * dims[3] !== map.data.length
    )
      throw new Error("Qwen 표지 잔여 글자 검증 맵을 읽을 수 없습니다.");
    return printedLines(map.data, dims[3], dims[2], size.width, size.height);
  }

  async dispose() {
    this.weights = undefined;
    await this.inference.dispose();
  }
}

function printedLines(
  probabilities: Float32Array,
  w: number,
  h: number,
  width: number,
  height: number,
): PixelRect[] {
  const mask = Uint8Array.from(probabilities, (p) => Number(p > 0.15));
  const out: PixelRect[] = [];
  for (const component of maskComponents(mask, w, h, 12)) {
    const b = component.rect;
    let score = 0;
    for (let y = 0; y < b.h; y++)
      for (let x = 0; x < b.w; x++)
        score +=
          Number(Boolean(component.data[y * b.w + x])) *
          probabilities[(b.y + y) * w + b.x + x];
    if (score / component.area < 0.6) continue;
    const margin = (0.7 * component.area) / (b.w + b.h);
    const left = Math.max(0, Math.floor(((b.x - margin) * width) / w)),
      top = Math.max(0, Math.floor(((b.y - margin) * height) / h));
    const right = Math.min(
        width,
        Math.ceil(((b.x + b.w + margin) * width) / w),
      ),
      bottom = Math.min(height, Math.ceil(((b.y + b.h + margin) * height) / h));
    if (Math.min(right - left, bottom - top) >= 3)
      out.push({ x: left, y: top, w: right - left, h: bottom - top });
  }
  return out;
}

export function survivingJacketLines(
  original: PixelRect[],
  edited: PixelRect[],
  stencil: Uint8Array,
  width: number,
  height: number,
) {
  const residual = new Uint8Array(width * height);
  for (const line of edited) {
    if (
      !original.some((b) => {
        const dx = Math.max(
          0,
          Math.min(b.x + b.w, line.x + line.w) - Math.max(b.x, line.x),
        );
        const dy = Math.max(
          0,
          Math.min(b.y + b.h, line.y + line.h) - Math.max(b.y, line.y),
        );
        return dx * dy > 0.48 * Math.min(line.w * line.h, b.w * b.h);
      })
    )
      continue;
    let selected = 0;
    for (let y = line.y; y < line.y + line.h; y++)
      for (let x = line.x; x < line.x + line.w; x++)
        selected += Number(Boolean(stencil[y * width + x]));
    if (selected < 0.48 * line.w * line.h) continue;
    const pad = Math.max(
      2,
      Math.min(8, Math.round(0.14 * Math.min(line.w, line.h))),
    );
    for (
      let y = Math.max(0, line.y - pad);
      y < Math.min(height, line.y + line.h + pad);
      y++
    )
      residual.fill(
        1,
        y * width + Math.max(0, line.x - pad),
        y * width + Math.min(width, line.x + line.w + pad),
      );
  }
  return residual;
}
