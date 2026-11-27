import { restoreNativePrintWindow } from "./qwenRuledShadow";
import { restoreOverlayStock } from "./qwenOverlayStock";
import { nativeImage, type NativeImage } from "electron";
import type { PixelRect } from "./maskGeometry";
import { availableParallelism } from "node:os";
import { compactSoundCondition } from "./qwenPrintedReference";
import { restoreLightEffectGradient } from "./qwenPaperBank";
import type { IllustratedTitleHint } from "./fluxWorkerTypes";
import {
  controlConditionMask,
  nativeQwenCondition,
} from "./qwenControlReferences";
import { createQwenFloatProcess } from "./qwenFloatInference";

import { restoreUniformQwenScreen } from "./qwenUniformScreen";
import { soundPaperBoundary } from "./qwenSoundPen";

const side = 512;
const area = side * side;

/** Mirror padding maintains the source aspect ratio at the LaMa input. */
function reflected(value: number, length: number) {
  if (length === 1) return 0;
  const period = 2 * (length - 1);
  const offset = ((value % period) + period) % period;
  return Math.min(offset, period - offset);
}

function inputTensors(
  source: NativeImage,
  mask: NativeImage,
  nativeScale: boolean,
) {
  const original = source.getSize();
  const fit = side / Math.max(original.width, original.height);
  const scale = nativeScale ? Math.min(1, fit) : fit;
  const size = {
    width: Math.max(1, Math.round(original.width * scale)),
    height: Math.max(1, Math.round(original.height * scale)),
  };
  const rgb = source.resize({ ...size, quality: "best" }).toBitmap();
  const ink = mask.resize({ ...size, quality: "best" }).toBitmap();
  const extendEdge = isWideEdgeMask(ink, size);
  const left = Math.floor((side - size.width) / 2);
  const top = Math.floor((side - size.height) / 2);
  const channels = new Float32Array(area * 3);
  const holes = new Float32Array(area);
  for (let y = 0; y < side; y++) {
    // Reflecting a nearby masthead across a narrow strip of missing artwork
    // feeds the network multiple copies of the same letters.
    const row =
      (extendEdge
        ? Math.max(0, Math.min(size.height - 1, y - top))
        : reflected(y - top, size.height)) * size.width;
    for (let x = 0; x < side; x++) {
      const src = (row + reflected(x - left, size.width)) * 4;
      const dst = y * side + x;
      channels[dst] = rgb[src + 2] / 255;
      channels[area + dst] = rgb[src + 1] / 255;
      channels[2 * area + dst] = rgb[src] / 255;
      holes[dst] = Number(ink[src] > 8);
    }
  }
  return {
    inputs: [
      { name: "image", data: channels, dims: [1, 3, side, side] },
      { name: "mask", data: holes, dims: [1, 1, side, side] },
    ],
    bounds: { x: left, y: top, ...size },
  };
}

function isWideEdgeMask(ink: Buffer, size: { width: number; height: number }) {
  if (size.width < 3 * size.height) return false;
  let left = size.width,
    right = -1,
    top = size.height,
    bottom = -1;
  for (let i = 0; i < size.width * size.height; i++) {
    if (ink[i * 4] <= 8) continue;
    const x = i % size.width,
      y = Math.floor(i / size.width);
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  return (
    right - left > 0.5 * size.width &&
    ((top > size.height * 0.5 && bottom >= 0.88 * size.height) ||
      (top <= size.height * 0.12 && bottom < 0.5 * size.height))
  );
}

export class QwenSubstrate {
  private readonly inference = createQwenFloatProcess();
  constructor(private readonly weights: string) {}

  uniformPrint(input: {
    inkBounds: PixelRect | null;
    original: Buffer;
    stencil: Uint8Array;
    width: number;
    height: number;
  }) {
    const pixels = restoreUniformQwenScreen(
      input.original,
      input.stencil,
      input.width,
      input.height,
      input.inkBounds,
    );
    if (pixels)
      return nativeImage.createFromBitmap(pixels, {
        width: input.width,
        height: input.height,
      });
  }

  async restore(
    source: NativeImage,
    mask: NativeImage,
    signal: AbortSignal,
    nativeScale = false,
  ) {
    signal.throwIfAborted();
    const { inputs, bounds } = inputTensors(source, mask, nativeScale);
    const prediction = await this.inference.run(
      {
        modelPath: this.weights,
        threads: Math.max(
          1,
          Math.min(8, Math.floor(availableParallelism() / 2)),
        ),
        inputs,
      },
      signal,
    );
    signal.throwIfAborted();
    if (prediction.dims.join(",") !== `1,3,${side},${side}`)
      throw new Error("Qwen 바탕 복원의 출력 크기가 올바르지 않습니다.");
    const square = opaqueBitmap(prediction.data);
    const size = source.getSize();
    const rgb = nativeImage
      .createFromBitmap(square, { width: side, height: side })
      .crop(bounds)
      .resize({ ...size, quality: "best" })
      .toBitmap();
    const original = source.toBitmap();
    const stencil = mask.toBitmap();
    for (let i = 0; i < stencil.length; i += 4) {
      if (stencil[i] <= 127) continue;
      original[i] = rgb[i];
      original[i + 1] = rgb[i + 1];
      original[i + 2] = rgb[i + 2];
    }
    return nativeImage.createFromBitmap(original, size);
  }

  async restoreStencil(
    source: NativeImage,
    condition: Uint8Array,
    _prefix: string,
    signal: AbortSignal,
  ) {
    const mask = await nativeQwenCondition(condition, source.getSize());
    return this.restore(source, mask, signal);
  }

  async restoreSoundBoundary(
    hint: IllustratedTitleHint | undefined,
    inputs: Parameters<QwenSubstrate["uniformPrint"]>[0] & {
      source: NativeImage;
    },
    signal: AbortSignal,
    unlabelled = false,
  ) {
    if (!unlabelled && (typeof hint !== "string" || !hint.startsWith("sound:")))
      return;
    const boundary = soundPaperBoundary(inputs, inputs.stencil, unlabelled);
    if (!boundary) return;
    const mask = await nativeQwenCondition(
      boundary.condition,
      inputs.source.getSize(),
    );
    const prediction = await this.restore(inputs.source, mask, signal, true);
    if (boundary.confirms(prediction.toBitmap())) return prediction;
  }

  async dispose() {
    await this.inference.dispose();
  }

  restoreSelectedStock(
    hint: IllustratedTitleHint | undefined,
    source: NativeImage,
    stencil: Uint8Array,
    prefix: string,
    signal: AbortSignal,
  ) {
    const size = source.getSize();
    if (hint === "ruled-sound-shadow" || hint === "balloon-edge-reading")
      return restoreNativePrintWindow(
        source,
        stencil,
        (image, mask) => this.restore(image, mask, signal),
        hint,
      );
    if (hint === "duotone-overlay")
      return restoreOverlayStock(source, stencil, (image, mask) =>
        this.restore(image, mask, signal),
      );
    if (hint === "isolated-title-stock")
      return this.restoreStencil(
        source,
        controlConditionMask(stencil, size, false),
        prefix,
        signal,
      );
    if (typeof hint !== "string" || !hint.startsWith("sound:")) return;
    const condition = compactSoundCondition(source, stencil, true);
    if (!condition) return;
    const restored = restoreLightEffectGradient(
      source.toBitmap(),
      condition,
      size.width,
      signal,
    );
    return restored
      ? Promise.resolve(nativeImage.createFromBitmap(restored, size))
      : this.restoreStencil(source, condition, prefix, signal);
  }
}

function opaqueBitmap(output: Float32Array) {
  const pixels = Buffer.allocUnsafe(area * 4);
  // The pinned export returns unit-range, planar RGB.
  for (let i = 0; i < area; i++) {
    pixels[i * 4] = byte(output[2 * area + i]);
    pixels[i * 4 + 1] = byte(output[area + i]);
    pixels[i * 4 + 2] = byte(output[i]);
    pixels[i * 4 + 3] = 255;
  }
  return pixels;
}

function byte(value: number) {
  if (!Number.isFinite(value))
    throw new Error("Qwen 바탕 복원의 출력값이 올바르지 않습니다.");
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}
