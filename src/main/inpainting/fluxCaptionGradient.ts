import type { InpaintingWindowMask } from "./inpaintingEngine";
import type { PixelRect } from "./maskGeometry";
import { windowMaskContainsPixel } from "./sourceGlyphResidualDiagnosticUtils";

type Caption = {
  source: Buffer;
  generated: Buffer;
  width: number;
  crop: PixelRect;
};

/** A ruled or illustrated caption cannot establish a smooth grayscale ramp.
 * Require identical paper on both sides of every selected scanline and check
 * every unowned pixel before replacing anything in the candidate. */
export function restoreVerifiedFluxCaptionGradient(
  input: Caption,
  mask: InpaintingWindowMask,
  core: InpaintingWindowMask,
) {
  const b = mask.bounds,
    c = core.bounds;
  if (
    b.w * b.h > 65536 ||
    c.x < b.x + 2 ||
    c.y < b.y + 2 ||
    c.x + c.w > b.x + b.w - 2 ||
    c.y + c.h > b.y + b.h - 2 ||
    !mask.data.every(Boolean)
  )
    return;
  for (const across of [true, false]) {
    const profile = measureCaptionRamp(input, b, core, across);
    if (!profile) continue;
    for (
      let y = Math.max(0, input.crop.y - b.y);
      y < Math.min(b.h, input.crop.y + input.crop.h - b.y);
      y++
    ) {
      for (
        let x = Math.max(0, input.crop.x - b.x);
        x < Math.min(b.w, input.crop.x + input.crop.w - b.x);
        x++
      ) {
        const at =
          ((b.y + y - input.crop.y) * input.crop.w + b.x + x - input.crop.x) *
          4;
        input.generated.fill(
          Math.min(profile[across ? x : y], input.generated[at + 3]),
          at,
          at + 3,
        );
      }
    }
    return;
  }
}

function measureCaptionRamp(
  input: Caption,
  b: PixelRect,
  core: InpaintingWindowMask,
  across: boolean,
) {
  const profile = readCaptionProfile(input, b, across);
  if (!profile) return;
  const start = 4 * (b.y * input.width + b.x);
  let marked = 0,
    darker = 0,
    lighter = 0;
  for (let y = 0; y < b.h; y++)
    for (let x = 0; x < b.w; x++) {
      const at = start + 4 * (y * input.width + x),
        v = input.source[at];
      if (!opaqueGray(input.source, at)) return;
      const selected = windowMaskContainsPixel(core, b.x + x, b.y + y);
      marked += Number(selected);
      const delta = v - profile[across ? x : y];
      if (Math.abs(delta) <= 2) continue;
      if (!selected) return;
      darker += Number(delta < 0);
      lighter += Number(delta > 0);
    }
  const ink = darker + lighter;
  if (!(darker && lighter) && ink >= 8 && ink <= marked * 0.6) return profile;
}

function opaqueGray(source: Buffer, at: number) {
  return (
    source[at + 3] === 255 &&
    Math.abs(source[at] - source[at + 1]) <= 1 &&
    Math.abs(source[at] - source[at + 2]) <= 1
  );
}

function readCaptionProfile(input: Caption, b: PixelRect, across: boolean) {
  const size = across ? b.w : b.h;
  const step = across ? 4 : input.width * 4;
  const start = 4 * (b.y * input.width + b.x);
  const profile = Uint8Array.from(
    { length: size },
    (_, i) => input.source[start + i * step],
  );
  const span = profile[size - 1] - profile[0];
  if (Math.abs(span) < 12) return;
  for (let i = 1; i < size; i++) {
    const slope = (profile[i] - profile[i - 1]) * Math.sign(span);
    if (slope < 0 || slope > 4) return;
  }
  return profile;
}
