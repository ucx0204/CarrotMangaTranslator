import type { NativeImage, Size } from "electron";
import { writeFile } from "node:fs/promises";
import { erodeBinaryMask } from "../bubbleLayout/bubbleDistanceTransform";
import { dilateBinaryMaskDisk } from "./patternMaskMorphology";
import {
  maskBoundsInRect,
  nativeImageFromMask,
  writePngFromMask,
} from "./imageRaster";
import {
  writeQwenRuleReferences,
  type NativePrintLaunch,
} from "./qwenNativePrintRegistration";
import type { IllustratedTitleHint } from "./fluxWorkerTypes";
export type InterruptedDialogue = { kind: "dialogue"; prior: NativeImage };
export type QwenReferenceCrop = {
  size: Size;
  condition: Uint8Array;
  prior: NativeImage;
  pairedWindow?: Parameters<typeof writeQwenRuleReferences>[2];
  prefix: string;
  nativeSourceMask?: string;
  titleSource?: NativeImage;
};

export function controlConditionMask(
  stencil: Uint8Array,
  size: { width: number; height: number },
  illustratedTitle: IllustratedTitleHint | InterruptedDialogue,
) {
  if (illustratedTitle === "solid-impact") return stencil;
  if (illustratedTitle)
    return dilateBinaryMaskDisk(stencil, size.width, size.height, 4);
  const { width, height } = size;
  const box = maskBoundsInRect(stencil, width, {
    x: 0,
    y: 0,
    w: width,
    h: height,
  });
  if (!box) throw new Error("Qwen 인페인팅 마스크가 비어 있습니다.");
  const radius = Math.max(
    2,
    Math.min(9, Math.round(0.043 * Math.min(box.w - 1, box.h - 1))),
  );
  const expanded = dilateBinaryMaskDisk(stencil, width, height, radius * 2);
  const closed = erodeBinaryMask(expanded, width, height, radius * 2);
  // Erosion at a page edge must retain the originally selected pixels.
  for (let i = 0; i < stencil.length; i++) if (stencil[i]) closed[i] = 1;
  return dilateBinaryMaskDisk(closed, width, height, radius);
}

export function nativeQwenCondition(stencil: Uint8Array, size: Size) {
  return nativeImageFromMask(stencil, size.width, size.height, size);
}

export async function writeQwenReferenceFiles(
  launch: NativePrintLaunch,
  crop: QwenReferenceCrop,
  target: Size,
  image: string,
  signal?: AbortSignal,
) {
  const { size, condition, prior, prefix } = crop;
  const referenceImage = crop.titleSource;
  const reference = crop.pairedWindow
    ? prefix + ".rule-reference.png"
    : referenceImage
      ? prefix + ".title-reference.png"
      : image;
  if (referenceImage)
    await writeFile(
      reference,
      referenceImage.resize({ ...target, quality: "best" }).toPNG(),
    );
  const maskPath = prefix + ".condition.png";
  const priorPath = prefix + ".prior.png";
  const view = crop.nativeSourceMask
    ? {
        x: 0,
        y: 0,
        w: size.width,
        h: size.height,
        nativeInk: true as const,
        mask: crop.nativeSourceMask,
      }
    : crop.pairedWindow;
  if (view) {
    await writeQwenRuleReferences(
      launch,
      prefix,
      view,
      target,
      { first: reference, original: priorPath, mask: maskPath },
      signal,
    );
  } else {
    await writeQwenReferencePair(
      { size, condition, prior },
      target,
      priorPath,
      maskPath,
    );
  }
  return { reference, maskPath, priorPath };
}

export async function writeQwenReferencePair(
  {
    size,
    condition,
    prior,
  }: Pick<QwenReferenceCrop, "size" | "condition" | "prior">,
  target: Size,
  priorPath: string,
  maskPath: string,
) {
  await writePngFromMask(maskPath, condition, size.width, size.height, target);
  await writeFile(
    priorPath,
    prior.resize({ ...target, quality: "best" }).toPNG(),
  );
}
