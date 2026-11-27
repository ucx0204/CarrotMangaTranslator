import type { FluxWorkerRequest } from "./fluxWorkerTypes";
import { writeNativeCrop } from "./fluxCropIO";
import {
  measuredCurvedDotStock,
  type QwenScreenCrop,
} from "./qwenCurvedDotStock";
import { measuredDotModulation } from "./qwenDotModulation";
import type { QwenCoverViewOptions as ViewOptions } from "./qwenCoverViewTypes";
import { nativeImage, type NativeImage } from "electron";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import {
  maskBoundsInRect,
  readGeneratedBitmap,
  writePngFromBitmap,
} from "./imageRaster";
import { repairJacketPrint } from "./qwenJacketView";
import type { QwenControlCrop } from "./qwenControlCrop";
import type { QwenMeasuredPrint } from "./qwenControlSampling";

type Size = { width: number; height: number };
type Crop = Awaited<ReturnType<QwenControlCrop["prepare"]>>;
export function pasteQwenView(
  page: Buffer,
  width: number,
  pixels: Buffer,
  view: Size & { x: number; y: number },
) {
  const stride = view.width * 4;
  for (let row = 0; row < view.height; row++) {
    pixels.copy(
      page,
      4 * ((view.y + row) * width + view.x),
      row * stride,
      (row + 1) * stride,
    );
  }
}

/** The model sees aligned source and mask references at the same variable size. */
export function qwenReferenceSize(
  width: number,
  height: number,
  maxPixels: number,
  maxUpscale = Infinity,
) {
  const limit = Math.min(1024 * 1024, maxPixels);
  if (
    ![width, height, limit].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    limit < 1024
  )
    throw new Error("유효하지 않은 Qwen 인페인팅 영역입니다.");
  const scale = Math.min(
    Math.sqrt(Math.min(1010 ** 2, limit) / (width * height)),
    2048 / Math.max(width, height),
  );
  let w = Math.max(32, Math.round((width * scale) / 32) * 32);
  let h = Math.max(32, Math.round((height * scale) / 32) * 32);
  while (w * h > limit) {
    if (w > 32 && (h === 32 || w / width > h / height)) w -= 32;
    else h -= 32;
  }
  const upper = (length: number) =>
    Math.max(32, Math.round((length * maxUpscale) / 32) * 32);
  return {
    width: Math.min(w, upper(width)),
    height: Math.min(h, upper(height)),
  };
}

/** Change the reference framing by one native grid interval, inside a bank of
 * exposed original artwork. The entire selected imprint remains in both views. */
export function alternateCoverBounds(
  stencil: Uint8Array,
  { width, height }: Size,
) {
  const full = { x: 0, y: 0, w: width, h: height };
  const ink = maskBoundsInRect(stencil, width, full);
  if (!ink || Math.min(width, height) < 160) return;
  const margins = [ink.y, height - ink.y - ink.h, ink.x, width - ink.x - ink.w];
  const widest = Math.max(...margins);
  if (widest < 64) return;
  const side = margins.indexOf(widest);
  return {
    x: side === 2 ? 16 : 0,
    y: side === 0 ? 16 : 0,
    width: width - (side >= 2 ? 16 : 0),
    height: height - (side < 2 ? 16 : 0),
  };
}

export async function selectCoverView(options: ViewOptions) {
  const { request, control, source, stencil, decoded, signal } = options;
  const size = source.getSize(),
    view = alternateCoverBounds(stencil, size);
  if (!view) return decoded;
  const directory = await mkdtemp(join(dirname(request.input), "qwen-cover-"));
  try {
    const score = async (bitmap: Buffer, name: string) => {
      const path = join(directory, name + ".png");
      await writeFile(path, nativeImage.createFromBitmap(bitmap, size).toPNG());
      return control.registration.exposedContourError(
        request.input,
        request.mask,
        path,
        signal,
      );
    };
    const originalError = await score(decoded, "first");
    if (originalError < 0.115) return decoded;
    const alternate = await generateAlternate(options, view, directory);
    if (!alternate) return decoded;
    const candidate = Buffer.from(decoded);
    pasteQwenView(candidate, size.width, alternate, view);
    const error = await score(candidate, "second");
    if (error < 0) return decoded;
    const useSecond = error + 0.02 < originalError;
    const preferred = useSecond ? "second.png" : "first.png";
    const peer = useSecond ? "first.png" : "second.png";
    return (
      (await control.reconcileCoverViews(
        request.input,
        request.mask,
        join(directory, preferred),
        join(directory, peer),
        size,
        signal,
      )) ?? (useSecond ? candidate : decoded)
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function generateAlternate(
  options: ViewOptions,
  view: Size & { x: number; y: number },
  directory: string,
) {
  const { source, stencil, signal, control } = options;
  const crop = source.crop(view),
    width = source.getSize().width,
    mask = new Uint8Array(view.width * view.height);
  for (let row = 0; row < view.height; row++) {
    const start = (view.y + row) * width + view.x;
    mask.set(stencil.subarray(start, start + view.width), row * view.width);
  }
  const prefix = join(directory, "reference"),
    input = prefix + ".png";
  const prepared: Crop = await control.prepare(
    crop,
    mask,
    prefix,
    signal,
    undefined,
    true,
  );
  const target = options.sizeFor(view.width, view.height);
  await writeFile(input, crop.resize({ ...target, quality: "best" }).toPNG());
  return options.sample(
    (output) => control.argumentsFor(prepared, target, input, output),
    join(directory, "alternate-output.png"),
    target,
    view,
    signal,
  );
}

/** Only revisit lettering still registered with the original printed faces. */
async function repairRemainingCoverPrint(
  options: ViewOptions,
  mode: "masthead" | "columns" | "ink-terminal",
  first: NativeImage,
) {
  const { request, control, signal } = options;
  const directory = await mkdtemp(join(dirname(request.input), "qwen-print-"));
  const size = first.getSize();
  let current = first;
  try {
    const maskFile = join(directory, "residual.png");
    const measure = async (image: NativeImage) => {
      const path = join(directory, "current.png");
      await writeFile(path, image.toPNG());
      return control.registration.remainingCoverPrint(
        request.input,
        request.mask,
        path,
        maskFile,
        mode,
        signal,
      );
    };
    let view = await measure(current);
    for (let pass = 0; view && pass < 5; pass++) {
      const { x, y, width, height, score } = view;
      const rect = { x, y, width, height };
      const local = current.crop(rect);
      const registered =
        view.fragment || mode === "ink-terminal"
          ? await restoreSmallSpot(options, local, maskFile)
          : await restoreRemainingLetters(
              options,
              local,
              mode,
              directory,
              maskFile,
            );
      if (!registered) break;
      const region = registered.toBitmap();
      const bitmap = current.toBitmap();
      pasteQwenView(bitmap, size.width, region, rect);
      const candidate = nativeImage.createFromBitmap(bitmap, size);
      const after = await measure(candidate);
      const requiredDrop = view.fragment ? 0.7 * view.fragment : 0.33 * score;
      if (after && after.score > score - requiredDrop) break;
      current = candidate;
      view = after;
    }
    return current;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function restoreRemainingLetters(
  options: ViewOptions,
  local: NativeImage,
  mode: "masthead" | "columns",
  directory: string,
  maskFile: string,
) {
  const { control, signal } = options;
  const input = join(directory, "native.png");
  await writeFile(input, local.toPNG());
  const raw = await sampleRemainingCoverPrint(
    options,
    local,
    mode,
    directory,
    input,
    maskFile,
  );
  if (!raw) return;
  return control.restoreMeasuredPrint(
    input,
    maskFile,
    raw,
    local.getSize(),
    signal,
    { kind: "glowing-print" },
  );
}

async function restoreSmallSpot(
  options: ViewOptions,
  local: NativeImage,
  maskFile: string,
) {
  const mask = nativeImage.createFromBuffer(await readFile(maskFile));
  const edge = mask.toBitmap(),
    original = local.toBitmap();
  const guide = (
    await options.control.restoreReference(local, mask, options.signal)
  ).toBitmap();
  for (let i = 0; i < original.length; i += 4) {
    const blend = Math.max(0, (edge[i] - 128) / 127);
    if (!blend) continue;
    for (let c = 0; c < 3; c++)
      original[i + c] = Math.round(
        original[i + c] + blend * (guide[i + c] - original[i + c]),
      );
  }
  return nativeImage.createFromBitmap(original, local.getSize());
}

async function sampleRemainingCoverPrint(
  options: ViewOptions,
  local: NativeImage,
  mode: "masthead" | "columns",
  directory: string,
  input: string,
  maskFile: string,
) {
  const { control, signal } = options;
  const { width, height } = local.getSize();
  const mask = nativeImage
    .createFromBuffer(await readFile(maskFile))
    .toBitmap();
  const stencil = Uint8Array.from({ length: width * height }, (_, i) =>
    Number(mask[i * 4] > 127),
  );
  const crop = await control.prepare(
    local,
    stencil,
    input,
    signal,
    maskFile,
    mode === "masthead" ? "masthead:" : "cover-columns:",
  );
  crop.printDescription =
    mode === "masthead"
      ? "把画面中仍然可见的整块彩色杂志大标志、所有假名和汉字、粗描边、白边和反光全部擦干净。沿可见原画接续头发及背景。保留人物姿势和原配色，得到没有标志的插画。"
      : "彻底擦除画面中仍然可见的这列竖排日文，从上到下的每个白色字、彩色轮廓、发光、影子和标点全部去掉。延续文字两边的头发、衣服和背景原画。";
  const target = options.sizeFor(width, height);
  const reference = join(directory, "reference.png");
  await writeFile(
    reference,
    local.resize({ ...target, quality: "best" }).toPNG(),
  );
  return options.sample(
    (output) => control.argumentsFor(crop, target, reference, output),
    join(directory, "edit.png"),
    target,
    { width, height },
    signal,
  );
}

export async function finishMeasuredPrint(
  options: ViewOptions,
  material: NonNullable<QwenMeasuredPrint>,
) {
  const { request, control, decoded, source, signal } = options;
  const native = await control.restoreMeasuredPrint(
    request.input,
    request.mask,
    decoded,
    source.getSize(),
    signal,
    material,
  );
  const hint = request.illustratedTitle;
  if (hint === "lettering" && source.getSize().height >= 400)
    return repairRemainingCoverPrint(options, "ink-terminal", native);
  if (typeof hint === "string" && hint.startsWith("masthead:"))
    return repairRemainingCoverPrint(options, "masthead", native);
  if (typeof hint === "string" && hint.startsWith("cover-columns:"))
    return repairRemainingCoverPrint(options, "columns", native);
  if (
    material.kind === "jacket" ||
    (typeof hint === "string" &&
      (hint.startsWith("pigment:") || hint.startsWith("layered-title:")))
  )
    return repairJacketPrint(options, native);
  return native;
}

function finishQwenScreen(
  crop: QwenScreenCrop,
  speech: boolean | undefined,
  paper: boolean,
  restore: (file: string) => Promise<unknown> | undefined,
  signal: AbortSignal,
) {
  if (speech) return paper ? undefined : restore;
  return async (file: string) => {
    await restore(file);
    signal.throwIfAborted();
    const repair = measuredCurvedDotStock(crop) ?? measuredDotModulation(crop);
    if (!repair) return;
    const decoded = await readGeneratedBitmap(file, crop.width, crop.height);
    const output = repair(decoded);
    if (output)
      await writePngFromBitmap(file, output, crop.width, crop.height, crop);
  };
}

export function writeScreenedQwenCrop(
  request: FluxWorkerRequest,
  crop: QwenScreenCrop,
  image: Electron.NativeImage,
  paper: boolean,
  signal: AbortSignal,
  control?: Pick<QwenControlCrop, "restorePrintedScreen">,
) {
  const restore = (file: string) =>
    control?.restorePrintedScreen(
      request.input,
      request.mask,
      file,
      signal,
      paper,
      Boolean(request.speechBubble),
    );
  const finish = finishQwenScreen(
    crop,
    request.speechBubble,
    paper,
    restore,
    signal,
  );
  return writeNativeCrop(request.output, image, crop.original, signal, finish);
}

/** Plate restoration has already run on these crops. Only sound effects need
 * the native dot check before the worker publishes their final PNG. */
export async function writeMeasuredQwenCrop(
  request: FluxWorkerRequest,
  crop: QwenScreenCrop,
  image: Electron.NativeImage,
  kind: QwenMeasuredPrint["kind"],
  signal: AbortSignal,
) {
  if (kind === "sound")
    return writeScreenedQwenCrop(request, crop, image, false, signal);
  await writeNativeCrop(request.output, image, crop.original, signal);
  if (kind === "dialogue") return "native-paper" as const;
}
