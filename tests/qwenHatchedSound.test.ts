import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeImage } from "electron";
vi.mock("electron", async () => ({
  nativeImage: (await import("./mcpImageNative.fixture")).imageNativeBoundary,
}));
import {
  registerHatchedSound,
  writeHatchedSound,
} from "../src/main/inpainting/qwenHatchedSound";

function printedPanel(mirror: boolean, rule = true) {
  const width = 176,
    height = 192;
  const original = Buffer.alloc(width * height * 4, 255);
  const stencil = new Uint8Array(width * height),
    paper = stencil.slice();
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + (mirror ? width - 1 - x : x);
      const wave = ((x + y) * Math.PI) / 5;
      const level = Math.round(
        220 + 24 * Math.cos(wave) + 7 * Math.sin(1.5 * wave),
      );
      const row = [23, 79, 138].find((top) => y >= top - 3 && y < top + 29);
      const left = row === 79 ? 32 : 39;
      const selected = row !== undefined && x >= left - 3 && x <= 66;
      const ink =
        row !== undefined && y >= row && y < row + 26 && x >= left && x <= 63;
      const panel = rule && x >= 28 && x <= 30;
      paper[i] = panel ? 5 : level;
      original.fill(
        panel || ink ? 5 : selected ? 254 : level,
        4 * i,
        4 * i + 3,
      );
      stencil[i] = selected ? 255 : 0;
    }
  return { original, stencil, width, height, paper };
}

it.each([false, true])(
  "continues real oblique ink on both sides of a ruled brush selection (mirrored %s)",
  (mirror) => {
    const crop = printedPanel(mirror);
    const prediction = Buffer.alloc(crop.original.length, 255);
    const recovered = registerHatchedSound(crop, prediction);
    if (!recovered)
      throw new Error("Failed to register the ruled brush selection");
    let error = 0,
      blankError = 0,
      outside = 0;
    crop.stencil.forEach((on, i) => {
      if (on) {
        error += Math.abs(recovered[4 * i] - crop.paper[i]);
        blankError += 255 - crop.paper[i];
      }
      if (!on) outside += Number(recovered[4 * i] !== crop.original[4 * i]);
    });
    expect(outside).toBe(0);
    expect(error).toBeLessThan(0.32 * blankError);
    expect(
      registerHatchedSound(printedPanel(mirror, false), prediction),
    ).toBeUndefined();
    const coloured = Buffer.from(crop.original);
    for (let i = 0; i < coloured.length; i += 4)
      coloured[i] = Math.min(255, coloured[i] + 19);
    expect(
      registerHatchedSound({ ...crop, original: coloured }, prediction),
    ).toBeUndefined();
  },
);

it("writes the registered brush prediction and leaves flat backgrounds to ordinary Qwen compositing", async () => {
  const folder = await mkdtemp(join(tmpdir(), "qwen-hatch-"));
  const output = join(folder, "crop.png");
  const crop = printedPanel(false);
  const prediction = Buffer.alloc(crop.original.length, 251);
  const signal = new AbortController().signal;
  const request = {
    input: "source.png",
    mask: "selection.png",
    output,
    steps: 40,
    strength: 1,
    maskPadding: 0,
    maxPixels: 1024 ** 2,
  };
  try {
    expect(await writeHatchedSound(request, crop, prediction, signal)).toBe(
      false,
    );
    const brush = { ...request, illustratedTitle: "brush" as const };
    const plain = Buffer.from(crop.original);
    crop.stencil.forEach((on, i) => {
      if (!on && plain[4 * i] > 5) plain.fill(255, 4 * i, 4 * i + 3);
    });
    expect(
      await writeHatchedSound(
        brush,
        { ...crop, original: plain },
        prediction,
        signal,
      ),
    ).toBe(false);
    expect(await writeHatchedSound(brush, crop, prediction, signal)).toBe(true);
    const finalized = nativeImage.createFromBuffer(await readFile(output));
    expect(
      finalized
        .toBitmap()
        .equals(registerHatchedSound(crop, prediction) ?? Buffer.alloc(0)),
    ).toBe(true);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
