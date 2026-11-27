import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NativeImage } from "electron";
import { PNG } from "pngjs";
import { resolveCodexImageSize } from "../pipeline/codexImageSize";
import type { Raster } from "../pipeline/codexTypesettingPixelSampling";
import type { PixelRect } from "./maskGeometry";
import type { CodexRepairRequest as Request } from "./inpaintingEngine";
import {
  CodexRepairGeometryError,
  type compositeCodexRepair,
} from "./codexRepairComposite";

export function prepareCodexRepairFrames(
  decoded: NativeImage,
  source: NativeImage,
  permission: Uint8Array,
) {
  const generated = decoded.getSize();
  const { width, height } = source.getSize();
  const aspectMismatch =
    Math.abs(Math.log(generated.width / generated.height / (width / height))) >
    0.025;
  const resize = (image: typeof decoded) =>
    PNG.sync.read(image.resize({ width, height, quality: "best" }).toPNG());
  function* crops() {
    if (!aspectMismatch) return;
    const scale = Math.min(generated.width / width, generated.height / height);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const horizontal = generated.width > w;
    const slack = horizontal ? generated.width - w : generated.height - h;
    const center = Math.floor(slack / 2);
    const crop = (bounds: PixelRect, framing: string) => {
      const { x, y, w, h } = bounds;
      const image = resize(decoded.crop({ x, y, width: w, height: h }));
      return { image, framing, bounds };
    };
    const centered = {
      x: horizontal ? center : 0,
      y: horizontal ? 0 : center,
      w,
      h,
    };
    yield crop(centered, "center-crop");
    const matched = matchCropBounds(
      { width, height, data: source.toBitmap() },
      permission,
      { ...generated, data: decoded.toBitmap() },
      centered,
      horizontal,
    );
    if (matched) yield crop(matched, "matched-crop");
  }
  return { candidate: resize(decoded), aspectMismatch, crops: crops() };
}

type ColorSample = { from: number; to: number };

/** Only unchanged source pixels may identify the position of the artwork. */
function cropSamples(
  source: Raster,
  permission: Uint8Array,
  generatedWidth: number,
  crop: Pick<PixelRect, "w" | "h">,
) {
  const samples: ColorSample[] = [];
  const step = Math.max(1, Math.ceil(Math.sqrt(permission.length / 1024)));
  for (let top = 0; top < source.height; top += step) {
    for (let left = 0; left < source.width; left += step) {
      const x = Math.min(source.width - 1, left + ((top / step) % step));
      const y = Math.min(source.height - 1, top + ((left / step) % step));
      const at = y * source.width + x;
      if (permission[at] || source.data[at * 4 + 3] !== 255) continue;
      const u = Math.floor(((x + 0.5) * crop.w) / source.width);
      const v = Math.floor(((y + 0.5) * crop.h) / source.height);
      samples.push({ from: at * 4, to: (v * generatedWidth + u) * 4 });
    }
  }
  return samples;
}

function cropError(
  samples: ColorSample[],
  source: Uint8Array,
  generated: Uint8Array,
  shift: number,
) {
  let error = 0;
  for (const { from, to } of samples) {
    const at = to + shift;
    if (generated[at + 3] !== 255) {
      error += 3 * 255;
      continue;
    }
    for (let channel = 0; channel < 3; channel++)
      error += Math.abs(source[from + channel] - generated[at + channel]);
  }
  return error / (3 * samples.length);
}

function matchCropBounds(
  original: Raster,
  permission: Uint8Array,
  generated: Raster,
  centered: PixelRect,
  horizontal: boolean,
) {
  const axis = horizontal
    ? ({ size: "width", span: "w", start: "x", stride: 4 } as const)
    : ({
        size: "height",
        span: "h",
        start: "y",
        stride: generated.width * 4,
      } as const);
  const extent = generated[axis.size];
  const proportional = centered[axis.span];
  // ImageGen may also stretch the artwork slightly along the padded axis.
  // Score small variations without running a full registration for each one.
  const spans = new Set(
    [1, 0.96, 1.04, 0.92, 1.08].map((factor) =>
      Math.min(extent, Math.max(1, Math.round(proportional * factor))),
    ),
  );
  const fits: Array<{ span: number; errors: Float64Array }> = [];
  let best = { error: Infinity, offset: 0, span: proportional };
  for (const span of spans) {
    const crop = { ...centered, [axis.span]: span };
    const samples = cropSamples(original, permission, generated.width, crop);
    if (samples.length < 32) return;
    const errors = new Float64Array(extent - span + 1);
    for (let offset = 0; offset < errors.length; offset++) {
      const error = cropError(
        samples,
        original.data,
        generated.data,
        offset * axis.stride,
      );
      errors[offset] = error;
      if (error < best.error) best = { error, offset, span };
    }
    fits.push({ span, errors });
  }
  // Repeated panels and blank paper cannot establish which copy to paste.
  const end = best.offset + best.span;
  const neighborhood = best.span * Math.max(3 / original[axis.size], 0.05);
  const competingError = best.error + Math.max(1, best.error * 0.1);
  if (
    best.error > 0.06 * 255 ||
    fits.some(({ span, errors }) =>
      errors.some(
        (error, offset) =>
          Math.max(
            Math.abs(offset - best.offset),
            Math.abs(offset + span - end),
          ) > neighborhood && error <= competingError,
      ),
    )
  )
    return;
  if (best.span === proportional && best.offset === centered[axis.start])
    return;
  return { ...centered, [axis.start]: best.offset, [axis.span]: best.span };
}

export async function recordRepair(
  directory: string,
  index: string,
  geometry: {
    rect: PixelRect;
    erase: PixelRect;
    mode: Request["mode"];
    generatedSize: { width: number; height: number };
    aspectMismatch: boolean;
  },
  repair: ReturnType<typeof compositeCodexRepair>,
) {
  const nativeSize = { width: geometry.rect.w, height: geometry.rect.h };
  const requestedSize = resolveCodexImageSize(nativeSize);
  await writeFile(
    join(directory, `splice-${index}-${randomUUID()}.json`),
    JSON.stringify({
      ...geometry,
      repairId: index,
      requestedSize,
      framing: repair.framing,
      cropBounds: repair.cropBounds,
      registration: repair.registration,
      thresholds: repair.difference.thresholds,
      tone: repair.tone,
      changedPixels: repair.difference.changedPixels,
    }),
  );
  if (geometry.aspectMismatch && !repair.registration.accepted) {
    const { generatedSize: generated, rect } = geometry;
    throw Object.assign(
      new CodexRepairGeometryError(
        `생성된 배경(${generated.width}×${generated.height})을 작업 영역(${rect.w}×${rect.h})에 맞춰도 원본 경계가 맞지 않습니다. 이 영역은 보류했습니다. 요청한 이미지 크기는 ${requestedSize.width}×${requestedSize.height}입니다.`,
      ),
      {
        repairId: index,
        requestedSize,
        generatedSize: generated,
        nativeSize,
        reason: repair.registration.reason,
      },
    );
  }
  // Misaligned context is not image noise. An inflated noise threshold can
  // suppress most removed glyphs while leaving a few changed pixels behind.
  // Those few pixels must not turn an unusable splice into a successful edit.
  if (
    (repair.difference.changedPixels === 0 ||
      (repair.difference.thresholds.fine > 72 &&
        repair.difference.thresholds.coarse > 42)) &&
    repair.registration.samples >= 32 &&
    repair.registration.contextErrorAfter > 0.06 &&
    repair.registration.boundary.worst > 0.12
  )
    throw new CodexRepairGeometryError(
      "생성된 배경의 구도·경계가 원본과 맞지 않아 적용하지 못했습니다.",
    );
}
