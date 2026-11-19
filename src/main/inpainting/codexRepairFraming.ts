import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NativeImage } from "electron";
import { PNG } from "pngjs";
import { resolveCodexImageSize } from "../pipeline/codexImageSize";
import type { PixelRect } from "./maskGeometry";
import type { CodexRepairRequest as Request } from "./inpaintingEngine";
import type { compositeCodexRepair } from "./codexRepairComposite";

export function prepareCodexRepairFrames(
  decoded: NativeImage,
  rect: PixelRect,
) {
  const generated = decoded.getSize();
  const aspectMismatch =
    Math.abs(Math.log(generated.width / generated.height / (rect.w / rect.h))) >
    0.025;
  const resize = (image: typeof decoded) =>
    PNG.sync.read(
      image.resize({ width: rect.w, height: rect.h, quality: "best" }).toPNG(),
    );
  return {
    candidate: resize(decoded),
    aspectMismatch,
    proportionalCrop: aspectMismatch
      ? () => {
          const scale = Math.min(
            generated.width / rect.w,
            generated.height / rect.h,
          );
          const width = Math.max(1, Math.round(rect.w * scale));
          const height = Math.max(1, Math.round(rect.h * scale));
          return resize(
            decoded.crop({
              x: Math.floor((generated.width - width) / 2),
              y: Math.floor((generated.height - height) / 2),
              width,
              height,
            }),
          );
        }
      : undefined,
  };
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
      registration: repair.registration,
      thresholds: repair.difference.thresholds,
      tone: repair.tone,
      changedPixels: repair.difference.changedPixels,
    }),
  );
  if (geometry.aspectMismatch && !repair.registration.accepted) {
    const { generatedSize: generated, rect } = geometry;
    throw Object.assign(
      new Error(
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
    throw new Error(
      "생성된 배경의 구도·경계가 원본과 맞지 않아 적용하지 못했습니다.",
    );
}
