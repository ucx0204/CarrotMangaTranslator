import { expect, it } from "vitest";
import { continueQwenPen } from "../src/main/inpainting/qwenPenContinuation";
import { distanceToMask } from "../src/main/inpainting/pageMaskComposite";
function pencil(transposed: boolean, style: "straight" | "one" | "mismatch") {
  const w = 112,
    h = 94,
    W = transposed ? h : w,
    H = transposed ? w : h;
  const orig = Buffer.alloc(W * H * 4, 255),
    expected = Buffer.from(orig),
    out = Buffer.from(orig),
    gray = new Uint8Array(W * H).fill(255),
    mask = new Uint8Array(W * H);
  const idx = (x: number, y: number) => (transposed ? x * W + y : y * W + x);
  for (let x = 0; x < w; x++) {
    const center = 22.5 + 0.47 * x + (style === "mismatch" && x > 56 ? 2.8 : 0),
      mass = Math.max(24, Math.min(185, 120 - 3.3 * (x - 39))),
      sig = 0.67;
    for (let y = 0; y < h; y++) {
      const i = idx(x, y),
        blocked = x >= 43 && x <= 58 && Math.abs(y - (22.5 + 0.47 * x)) < 4;
      const level =
        style === "one" && x > 58
          ? 255
          : Math.round(
              255 -
                (mass * Math.exp(-0.5 * ((y - center) / sig) ** 2)) /
                  (2.5066 * sig),
            );
      expected.fill(level, i * 4, i * 4 + 3);
      orig.fill(blocked ? 9 : level, i * 4, i * 4 + 3);
      out.fill(blocked ? 255 : level, i * 4, i * 4 + 3);
      gray[i] = orig[i * 4];
      mask[i] = Number(blocked);
    }
  }
  const baseline = Buffer.from(out);
  continueQwenPen({
    source: orig,
    out,
    gray,
    distance: distanceToMask(mask, W, H),
    offset: (i) => i * 4,
    width: W,
    height: H,
  });
  let err = 0,
    initial = 0,
    delta = 0,
    non = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      err += Math.abs(out[4 * i] - expected[4 * i]);
      initial += 255 - expected[4 * i];
      delta += 255 - out[4 * i];
    } else non += Number(out[4 * i] !== baseline[4 * i]);
  }
  return { ratio: err / initial, delta, non };
}

it.each([false, true])(
  "continues a measured fading line across a selected face in both orientations (%s)",
  (transposed) => {
    const result = pencil(transposed, "straight");
    expect(result.ratio).toBeLessThan(0.12);
    expect(result.non).toBe(0);
    expect(pencil(transposed, "one").delta).toBe(0);
    expect(pencil(transposed, "mismatch").delta).toBe(0);
  },
);
