import { expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nativeImage } from "electron";
vi.mock("electron", async () => ({
  nativeImage: (await import("./mcpImageNative.fixture")).imageNativeBoundary,
}));
import { measuredCurvedDotStock } from "../src/main/inpainting/qwenCurvedDotStock";
import {
  writeScreenedQwenCrop,
  writeMeasuredQwenCrop,
} from "../src/main/inpainting/qwenCoverViews";
function letterFace(x: number, y: number) {
  return (
    (y >= 77 && y <= 97 && x >= 78 && x <= 199) ||
    (y >= 61 && y <= 107 && x >= 158 && x <= 166)
  );
}

function plate(
  mode: "horizontal" | "vertical" | "mirrored" = "horizontal",
  style: "regular" | "noisy" | "absent-edge" | "coloured-noise" = "regular",
) {
  const W = 280,
    H = 200,
    transpose = mode === "vertical",
    mirror = mode === "mirrored",
    width = transpose ? H : W,
    height = transpose ? W : H;
  const orig = Buffer.alloc(W * H * 4, 255),
    substrate = Buffer.from(orig),
    prediction = Buffer.from(orig),
    stencil = new Uint8Array(W * H);
  let seed = 31;
  const random = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const nativeX = mirror ? W - 1 - x : x,
        i = transpose ? nativeX * width + y : y * width + nativeX;
      const edge = 113 + 0.2 * (y - 85) + 0.0008 * (y - 85) ** 2,
        offset = x - edge;
      const period =
        style === "noisy"
          ? random() * 2 - 1
          : Math.cos((2 * Math.PI * x) / 5) * Math.cos((2 * Math.PI * y) / 5);
      const screen = 223 + 23 * period;
      const fraction =
        style === "absent-edge"
          ? 0
          : 0.9 * Math.exp(-0.5 * (offset / 0.83) ** 2);
      const chroma =
        style === "coloured-noise" ? Math.round(20 * (random() * 2 - 1)) : 0;
      const letter = letterFace(x, y);
      stencil[i] = letter ? 255 : 0;
      for (let c = 0; c < 3; c++) {
        const v = Math.round(
          ((offset < 0 ? 254 : screen) - (offset < 0 ? 0 : c * 2)) *
            (1 - fraction),
        );
        const tone = Math.max(
          0,
          Math.min(255, v + (offset > 3 ? [chroma, 0, -chroma][c] : 0)),
        );
        substrate[4 * i + c] = tone;
        orig[4 * i + c] = letter ? 15 : tone;
        prediction[4 * i + c] = letter ? 254 : tone;
      }
    }
  return { original: orig, stencil, width, height, substrate, prediction };
}

it.each(["horizontal", "mirrored", "vertical"] as const)(
  "restores source dot phase, tint and a covered outline on %s artwork",
  (mode) => {
    const img = plate(mode);
    const repair = measuredCurvedDotStock(img);
    const out = repair?.(img.prediction);
    if (!out) throw Error("Measured native dot plate unavailable");
    let error = 0,
      blank = 0,
      changedAlpha = 0;
    img.stencil.forEach((on, i) => {
      if (!on) return;
      for (let c = 0; c < 3; c++) {
        error += Math.abs(out[4 * i + c] - img.substrate[4 * i + c]);
        blank += Math.abs(img.prediction[4 * i + c] - img.substrate[4 * i + c]);
      }
      changedAlpha += Number(out[4 * i + 3] !== 255);
    });
    expect(changedAlpha).toBe(0);
    expect(error).toBeLessThan(0.05 * blank);
    expect(repair?.(img.substrate)).toBeUndefined();
  },
);
it.each(["noisy", "absent-edge", "coloured-noise"] as const)(
  "declines an unregistered %s surface",
  (style) => {
    const img = plate("horizontal", style);
    expect(measuredCurvedDotStock(img)).toBeUndefined();
  },
);
it("preserves existing speech restoration and writes measured colour through the regular staged PNG boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qwen-curved-stock-"));
  try {
    const img = plate(),
      signal = new AbortController().signal;
    const file = join(dir, "crop.png");
    const req = {
      input: "source.png",
      mask: "mask.png",
      output: file,
      steps: 40,
      strength: 1,
      maskPadding: 0,
      maxPixels: 1024 ** 2,
    };
    const predicted = nativeImage.createFromBitmap(img.prediction, img);
    const control = { restorePrintedScreen: vi.fn(async () => {}) };
    await writeScreenedQwenCrop(req, img, predicted, false, signal, control);
    const result = nativeImage
      .createFromBuffer(await readFile(file))
      .toBitmap();
    expect(
      result.equals(
        measuredCurvedDotStock(img)?.(img.prediction) ?? Buffer.alloc(0),
      ),
    ).toBe(true);
    const speech = { ...req, speechBubble: true };
    await writeScreenedQwenCrop(speech, img, predicted, false, signal, control);
    expect(control.restorePrintedScreen).toHaveBeenCalledTimes(2);
    await writeScreenedQwenCrop(speech, img, predicted, true, signal, control);
    expect(control.restorePrintedScreen).toHaveBeenCalledTimes(2);
    await writeScreenedQwenCrop(
      req,
      { ...img, stencil: new Uint8Array(img.stencil.length) },
      predicted,
      false,
      signal,
    );
    expect(
      nativeImage.createFromBuffer(await readFile(file)).toBitmap(),
    ).toEqual(img.prediction);
    await writeScreenedQwenCrop(
      req,
      img,
      nativeImage.createFromBitmap(img.substrate, img),
      false,
      signal,
    );
    expect(
      nativeImage.createFromBuffer(await readFile(file)).toBitmap(),
    ).toEqual(img.substrate);
    const aborted = new AbortController();
    const interrupt = {
      restorePrintedScreen: vi.fn(async () => {
        aborted.abort();
      }),
    };
    await expect(
      writeScreenedQwenCrop(
        req,
        img,
        predicted,
        false,
        aborted.signal,
        interrupt,
      ),
    ).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("writes measured sounds with the native screen and retains the dialogue worker classification", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qwen-measured-sound-"));
  try {
    const img = plate(),
      signal = new AbortController().signal;
    const file = join(dir, "crop.png");
    const req = {
      input: "source.png",
      mask: "mask.png",
      output: file,
      steps: 40,
      strength: 1,
      maskPadding: 0,
      maxPixels: 1024 ** 2,
    };
    const predicted = nativeImage.createFromBitmap(img.prediction, img);
    const result = measuredCurvedDotStock(img)?.(img.prediction);
    if (!result) throw Error("Expected a measured crossing");
    expect(
      await writeMeasuredQwenCrop(req, img, predicted, "sound", signal),
    ).toBeUndefined();
    expect(
      nativeImage.createFromBuffer(await readFile(file)).toBitmap(),
    ).toEqual(result);
    expect(
      await writeMeasuredQwenCrop(req, img, predicted, "dialogue", signal),
    ).toBe("native-paper");
    expect(
      await writeMeasuredQwenCrop(req, img, predicted, "jacket", signal),
    ).toBeUndefined();
    expect(
      nativeImage.createFromBuffer(await readFile(file)).toBitmap(),
    ).toEqual(img.prediction);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
