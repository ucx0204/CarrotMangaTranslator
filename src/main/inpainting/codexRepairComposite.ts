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
) {
  const rough = codexRepairDifference(original, candidate, permission);
  const alignmentMask =
    mode === "paint"
      ? permission
      : dilateBinaryMaskDisk(rough.seed, original.width, original.height, 3);
  const registration = registerTypesettingPatch(
    original,
    candidate,
    erase,
    alignmentMask,
  );
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
  return { output, registration, difference, tone: tone.curves };
}
