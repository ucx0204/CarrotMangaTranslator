import { nativeImage, type NativeImage } from "electron";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { QwenCoverViewOptions as ViewOptions } from "./qwenCoverViewTypes";
import { writePngFromMask } from "./imageRaster";
import { survivingJacketLines } from "./qwenJacketVerifier";
import { writeNativeCrop, type readNativeCropInputs } from "./fluxCropIO";
import type {
  FluxWorkerRequest,
  FluxWorkerCropResult,
} from "./fluxWorkerTypes";
import type { QwenControlCrop } from "./qwenControlCrop";

/** Use all four physical cover edges to show the inset illustration upright,
 * then return only its selected ink to the original page coordinates. */
type JacketCrop = Pick<
  Awaited<ReturnType<typeof readNativeCropInputs>>,
  "original" | "stencil" | "source" | "width" | "height"
>;

export async function repairObliqueJacket(
  control: QwenControlCrop | undefined,
  request: FluxWorkerRequest,
  inputs: JacketCrop,
  signal: AbortSignal,
  edit: (request: FluxWorkerRequest) => Promise<FluxWorkerCropResult>,
) {
  if (
    !control ||
    request.speechBubble ||
    request.illustratedTitle ||
    !couldBeInset(inputs)
  )
    return false;
  const dir = await mkdtemp(join(dirname(request.input), "qwen-inset-"));
  try {
    const plane = (mode: "prepare" | "compose") =>
      control.registration.processJacketPlane(
        mode,
        request.input,
        request.mask,
        dir,
        signal,
      );
    if (!(await plane("prepare"))) return false;
    await edit({
      ...request,
      input: join(dir, "book.png"),
      mask: join(dir, "ink.png"),
      output: join(dir, "edited.png"),
      illustratedTitle: "upright-jacket",
    });
    await plane("compose");
    const native = nativeImage.createFromBuffer(
      await readFile(join(dir, "native.png")),
    );
    await writeNativeCrop(request.output, native, inputs.original, signal);
    return true;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function couldBeInset(inputs: JacketCrop) {
  const { width, height, stencil, original } = inputs;
  if (width * height > 800000 || Math.min(width, height) < 140) return false;
  let left = width,
    right = -1,
    top = height,
    bottom = -1,
    area = 0,
    coloured = 0;
  for (let i = 0; i < stencil.length; i++) {
    if (!stencil[i]) continue;
    const x = i % width,
      y = Math.floor(i / width),
      k = 4 * i;
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
    area++;
    if (
      Math.max(original[k], original[k + 1], original[k + 2]) -
        Math.min(original[k], original[k + 1], original[k + 2]) >
      35
    )
      coloured++;
  }
  const w = right - left + 1,
    h = bottom - top + 1;
  return (
    w >= 85 &&
    w <= 341 &&
    h >= 35 &&
    h <= 201 &&
    area > 0.8 * w * h &&
    coloured > 0.15 * area
  );
}

export async function repairJacketPrint(
  options: ViewOptions,
  first: NativeImage,
) {
  const { control, signal, source, stencil } = options;
  const { width, height } = source.getSize();
  const verifier = control.jacketVerifier;
  const edited = await verifier.lines(first, signal);
  if (!edited.length) return first;
  const original = await verifier.lines(source, signal);
  const remaining = (lines: typeof original) =>
    survivingJacketLines(original, lines, stencil, width, height);
  const mask = remaining(edited);
  const area = mask.reduce((count, marked) => count + marked, 0);
  if (!area) return first;
  const dir = await mkdtemp(
    join(dirname(options.request.input), "qwen-jacket-"),
  );
  try {
    const native = join(dir, "first.png"),
      stencilPath = join(dir, "print.png"),
      size = { width, height };
    await writeFile(native, first.toPNG());
    await writePngFromMask(stencilPath, mask, width, height, size);
    const maskImage = nativeImage.createFromBuffer(await readFile(stencilPath));
    const background = await control.restoreReference(first, maskImage, signal);
    const prefix = join(dir, "guide");
    const crop = await control.prepare(
      background,
      mask,
      prefix,
      signal,
      stencilPath,
      "jacket:",
    );
    crop.printDescription =
      "修复这幅原画被遮挡而模糊的部位，按旁边可见的角色把身体、手臂、衣褶、发丝及背景细节完整画回来。保持原有角色、姿态、轮廓、配色、比例和画风，使补全部位和现有插画自然连贯。画面是纯插画，所有位置都是原画，不要加书名、标志、作者、文字和数字。";
    const target = options.sizeFor(width, height),
      reference = prefix + ".png";
    await writeFile(
      reference,
      background.resize({ ...target, quality: "best" }).toPNG(),
    );
    const raw = await options.sample(
      (output) => control.argumentsFor(crop, target, reference, output),
      join(dir, "edited.png"),
      target,
      size,
      signal,
    );
    if (!raw) return first;
    const candidate = await control.restoreMeasuredPrint(
      native,
      stencilPath,
      raw,
      size,
      signal,
      { kind: "illustration" },
    );
    const after = remaining(await verifier.lines(candidate, signal)).reduce(
      (count, marked) => count + marked,
      0,
    );
    if (after >= 0.45 * area) return first;
    const paint = await control.registration.registerImage(
      "qwen-restore-illustration.py",
      options.request.input,
      options.request.mask,
      candidate,
      signal,
      "--credit-paint",
    );
    return paint ?? candidate;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
