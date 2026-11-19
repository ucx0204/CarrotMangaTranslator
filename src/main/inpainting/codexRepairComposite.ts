import type { Raster } from "../pipeline/codexTypesettingPixelSampling";
import {
  compositeRegisteredPatch,
  registerTypesettingPatch,
} from "../pipeline/codexTypesettingRegistration";
import type { PixelRect } from "./maskGeometry";
import { dilateBinaryMaskDisk } from "./patternMaskMorphology";
import { codexRepairDifference } from "./codexRepairDifference";
import { matchCodexRepairTone } from "./codexRepairTone";

/** No model calls: align one generated result and preserve unchanged source pixels. */
export function compositeCodexRepair(
  original: Raster,
  candidate: Raster,
  erase: PixelRect,
  permission: Uint8Array,
  mode: "region" | "paint",
  paintedCore?: Uint8Array,
  {
    proportionalCrop,
    selection,
  }: { proportionalCrop?: () => Raster; selection?: Uint8Array } = {},
) {
  function align(image: Raster) {
    const alignmentMask =
      mode === "paint"
        ? permission
        : dilateBinaryMaskDisk(
            codexRepairDifference(original, image, permission).seed,
            original.width,
            original.height,
            3,
          );
    return {
      alignmentMask,
      registration: registerTypesettingPatch(
        original,
        image,
        erase,
        alignmentMask,
      ),
    };
  }
  let { alignmentMask, registration } = align(candidate);
  let framing = "resize";
  if (proportionalCrop && !registration.accepted) {
    const image = proportionalCrop();
    const recovered = align(image);
    // Cropping can remove context. Require the existing independent edge checks
    // against the source before accepting this alternative framing.
    if (recovered.registration.accepted) {
      candidate = image;
      ({ alignmentMask, registration } = recovered);
      framing = "center-crop";
    }
  }
  if (!registration.supported || !registration.opaque)
    throw new Error("Codex 결과가 선택 영역을 완전히 덮지 못했습니다.");
  const aligned = { ...original, data: Buffer.from(original.data) };
  compositeRegisteredPatch(
    aligned,
    candidate,
    { x: 0, y: 0, w: original.width, h: original.height },
    { x: 0, y: 0 },
    registration.transform,
  );
  const tone = matchCodexRepairTone(original, aligned, alignmentMask);
  const difference = codexRepairDifference(
    original,
    tone.output,
    permission,
    mode === "paint" ? (paintedCore ?? permission) : undefined,
    selection,
  );
  const output = { ...original, data: Buffer.from(original.data) };
  for (let at = 0; at < permission.length; at++) {
    const alpha = difference.opacity[at];
    if (!alpha) continue;
    for (let channel = 0; channel < 3; channel++) {
      const index = at * 4 + channel;
      output.data[index] = Math.round(
        original.data[index] * (1 - alpha) + tone.output.data[index] * alpha,
      );
    }
  }
  return { output, registration, difference, tone: tone.curves, framing };
}
