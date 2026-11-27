import { restoreMirroredFrameCorner } from "./qwenFrameCorner";
import { matchCoverStock } from "./qwenCoverStock";
import type { FluxWindowProcessArgs } from "./fluxEngineRunnerTypes";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { nativeImage } from "electron";
import type { FluxPreparedCrop } from "./fluxCropTiling";
import {
  maskBoundsInRect,
  readGeneratedBitmap,
  writePngFromBitmap,
  writePngFromMask,
} from "./imageRaster";
import { suppressInventedFluxBalloon } from "./fluxInventedBalloon";
import { restoreFluxFlatBackground } from "./fluxFlatBackground";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { constrainPrintChroma, measurePrintChroma } from "./qwenPrintChroma";

export async function readNativeCropInputs(
  inputPath: string,
  maskPath: string,
) {
  const source = nativeImage.createFromBuffer(await readFile(inputPath));
  const mask = nativeImage.createFromBuffer(await readFile(maskPath));
  const { width, height } = source.getSize();
  if (
    source.isEmpty() ||
    mask.isEmpty() ||
    width !== mask.getSize().width ||
    height !== mask.getSize().height
  )
    throw new Error("Qwen 원본과 지우기 마스크의 크기가 일치하지 않습니다.");
  const bitmap = mask.toBitmap();
  const stencil = Uint8Array.from({ length: width * height }, (_, i) =>
    bitmap[i * 4] > 127 ? 255 : 0,
  );
  const inkBounds = maskBoundsInRect(stencil, width, {
    x: 0,
    y: 0,
    w: width,
    h: height,
  });
  return {
    source,
    width,
    height,
    stencil,
    original: source.toBitmap(),
    inkBounds,
  };
}

export async function writeNativeCrop(
  output: string,
  image: Electron.NativeImage,
  original: Buffer,
  signal: AbortSignal,
  finish?: (staged: string) => Promise<unknown> | undefined,
) {
  signal.throwIfAborted();
  const staged = output + "." + randomUUID() + ".png";
  try {
    const palette = measurePrintChroma(original);
    const size = image.getSize();
    if (finish) {
      await writeFile(staged, image.toPNG());
      await finish(staged);
      if (palette)
        await constrainFinishedPrint(staged, size, original, palette);
    } else {
      const pixels = palette && image.toBitmap();
      const result =
        pixels && palette && constrainPrintChroma(original, pixels, palette)
          ? nativeImage.createFromBitmap(pixels, size)
          : image;
      await writeFile(staged, result.toPNG());
    }
    signal.throwIfAborted();
    await rename(staged, output);
  } finally {
    await rm(staged, { force: true });
  }
}

async function constrainFinishedPrint(
  staged: string,
  size: { width: number; height: number },
  original: Buffer,
  palette: NonNullable<ReturnType<typeof measurePrintChroma>>,
) {
  const pixels = await readGeneratedBitmap(staged, size.width, size.height);
  if (constrainPrintChroma(original, pixels, palette))
    await writePngFromBitmap(staged, pixels, size.width, size.height, size);
}

export function readFluxWindowCandidates(
  path: string,
  args: FluxWindowProcessArgs,
  crop: FluxPreparedCrop["paddedBounds"],
  nativePaper: boolean,
) {
  return readFluxCropCandidates(path, {
    source: args.sourceBitmap,
    crop,
    constraint: args.runOptions.compositeConstraints?.[args.index] ?? null,
    speechBubble: args.runOptions.speechBubbleWindows?.[args.index],
    registeredLettering:
      args.runOptions.illustratedTitleWindows?.[args.index] === "lettering",
    core: args.compositeMasks?.[args.index],
    nativePaper,
    width: args.width,
    height: args.height,
  });
}

export async function readFluxCropCandidates(
  path: string,
  options: {
    source: Buffer;
    crop: FluxPreparedCrop["paddedBounds"];
    constraint: InpaintingWindowMask | null;
    width: number;
    height: number;
    speechBubble?: boolean;
    registeredLettering?: boolean;
    core?: InpaintingWindowMask;
    nativePaper?: boolean;
  },
): Promise<{ generated: Buffer; contextGenerated: Buffer }> {
  const contextGenerated = await readGeneratedBitmap(
    path,
    options.crop.w,
    options.crop.h,
  );
  if (options.nativePaper)
    return { generated: contextGenerated, contextGenerated };
  restoreFluxFlatBackground({
    ...options,
    speechBubble: false,
    generated: contextGenerated,
  });
  const generated = options.speechBubble
    ? Buffer.from(contextGenerated)
    : contextGenerated;
  if (options.speechBubble)
    restoreFluxFlatBackground({ ...options, generated });
  return {
    // The illustrated lettering edit has already registered outlines against
    // the original. Its enclosed white shapes can be leaves or garment folds.
    generated: options.registeredLettering
      ? generated
      : suppressInventedFluxBalloon({ ...options, generated }),
    contextGenerated,
  };
}

export function resolveFluxCropPaths(
  runDir: string,
  index: number,
  tileIndex: number,
): { inputPath: string; maskPath: string; outputPath: string } {
  const stem = `${index}-${tileIndex}`;
  return {
    inputPath: join(runDir, `input-${stem}.png`),
    maskPath: join(runDir, `mask-${stem}.png`),
    outputPath: join(runDir, `output-${stem}.png`),
  };
}

export async function writeFluxCropInputs(
  paths: { inputPath: string; maskPath: string },
  crop: FluxPreparedCrop,
  cropBitmap: Buffer,
): Promise<void> {
  await writePngFromBitmap(
    paths.inputPath,
    cropBitmap,
    crop.paddedBounds.w,
    crop.paddedBounds.h,
    crop.processSize,
  );
  await writePngFromMask(
    paths.maskPath,
    crop.localMask,
    crop.paddedBounds.w,
    crop.paddedBounds.h,
    crop.processSize,
  );
}

export function matchIllustratedCrop(
  args: FluxWindowProcessArgs,
  crop: FluxPreparedCrop,
  generated: Buffer,
) {
  const hint = args.runOptions.illustratedTitleWindows?.[args.index];
  const core = args.compositeMasks?.[args.index];
  if (hint === true && core && args.cropStrategy === "worker-resize")
    matchCoverStock(
      args.sourceBitmap,
      args.width,
      generated,
      crop.paddedBounds,
      core,
    );
  if (
    args.cropStrategy === "worker-resize" &&
    !args.runOptions.speechBubbleWindows?.[args.index] &&
    (!hint || (typeof hint === "string" && hint.startsWith("sound:")))
  )
    restoreMirroredFrameCorner({
      source: args.sourceBitmap,
      width: args.width,
      height: args.height,
      crop: crop.paddedBounds,
      selected: crop.localMask,
      generated,
    });
}
