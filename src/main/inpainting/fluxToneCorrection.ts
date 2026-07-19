import { clamp } from "../../shared/geometry";

export function matchFluxOutputToOriginalContext(
  original: Buffer,
  generated: Buffer,
  inpaintMask: Uint8Array,
): boolean {
  const pixelCount = Math.min(
    inpaintMask.length,
    Math.floor(original.length / 4),
    Math.floor(generated.length / 4),
  );
  const stats = measureFluxContextTone(
    original,
    generated,
    inpaintMask,
    pixelCount,
  );
  if (!stats || !fluxContextNeedsCorrection(stats)) {
    return false;
  }
  const luminanceScale = clamp(stats.originalYStd / stats.generatedYStd, 0.5, 2);
  const cbShift = stats.originalCbMean - stats.generatedCbMean;
  const crShift = stats.originalCrMean - stats.generatedCrMean;
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    const tone = rgbToYCbCr(
      generated[offset] ?? 0,
      generated[offset + 1] ?? 0,
      generated[offset + 2] ?? 0,
    );
    const corrected = yCbCrToRgb(
      (tone.y - stats.generatedYMean) * luminanceScale +
        stats.originalYMean,
      tone.cb + cbShift,
      tone.cr + crShift,
    );
    generated[offset] = corrected.r;
    generated[offset + 1] = corrected.g;
    generated[offset + 2] = corrected.b;
  }
  return true;
}

type FluxContextToneStats = {
  generatedCbMean: number;
  generatedCrMean: number;
  generatedYMean: number;
  generatedYStd: number;
  originalCbMean: number;
  originalCrMean: number;
  originalYMean: number;
  originalYStd: number;
};

function measureFluxContextTone(
  original: Buffer,
  generated: Buffer,
  inpaintMask: Uint8Array,
  pixelCount: number,
): FluxContextToneStats | null {
  let samples = 0;
  let originalY = 0;
  let originalYSquared = 0;
  let originalCb = 0;
  let originalCr = 0;
  let generatedY = 0;
  let generatedYSquared = 0;
  let generatedCb = 0;
  let generatedCr = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    if (inpaintMask[index]) {
      continue;
    }
    const offset = index * 4;
    const originalTone = rgbToYCbCr(
      original[offset] ?? 0,
      original[offset + 1] ?? 0,
      original[offset + 2] ?? 0,
    );
    const generatedTone = rgbToYCbCr(
      generated[offset] ?? 0,
      generated[offset + 1] ?? 0,
      generated[offset + 2] ?? 0,
    );
    samples += 1;
    originalY += originalTone.y;
    originalYSquared += originalTone.y * originalTone.y;
    originalCb += originalTone.cb;
    originalCr += originalTone.cr;
    generatedY += generatedTone.y;
    generatedYSquared += generatedTone.y * generatedTone.y;
    generatedCb += generatedTone.cb;
    generatedCr += generatedTone.cr;
  }
  if (samples < 64) {
    return null;
  }
  const originalYMean = originalY / samples;
  const generatedYMean = generatedY / samples;
  return {
    originalYMean,
    originalYStd: Math.sqrt(
      Math.max(1e-6, originalYSquared / samples - originalYMean ** 2),
    ),
    originalCbMean: originalCb / samples,
    originalCrMean: originalCr / samples,
    generatedYMean,
    generatedYStd: Math.sqrt(
      Math.max(1e-6, generatedYSquared / samples - generatedYMean ** 2),
    ),
    generatedCbMean: generatedCb / samples,
    generatedCrMean: generatedCr / samples,
  };
}

function fluxContextNeedsCorrection(stats: FluxContextToneStats): boolean {
  return (
    Math.abs(stats.originalYMean - stats.generatedYMean) >= 1.3 ||
    Math.abs(stats.originalYStd - stats.generatedYStd) >= 2 ||
    Math.abs(stats.originalCbMean - stats.generatedCbMean) >= 1 ||
    Math.abs(stats.originalCrMean - stats.generatedCrMean) >= 1
  );
}

function rgbToYCbCr(
  r: number,
  g: number,
  b: number,
): { y: number; cb: number; cr: number } {
  return {
    y: 0.299 * r + 0.587 * g + 0.114 * b,
    cb: 128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
    cr: 128 + 0.5 * r - 0.418688 * g - 0.081312 * b,
  };
}

function yCbCrToRgb(
  y: number,
  cb: number,
  cr: number,
): { r: number; g: number; b: number } {
  return {
    r: clamp(Math.round(y + 1.402 * (cr - 128)), 0, 255),
    g: clamp(
      Math.round(y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128)),
      0,
      255,
    ),
    b: clamp(Math.round(y + 1.772 * (cb - 128)), 0, 255),
  };
}
