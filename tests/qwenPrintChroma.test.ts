import { expect, it, vi } from "vitest";
import { nativeImage } from "electron";
import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeNativeCrop } from "../src/main/inpainting/fluxCropIO";
vi.mock("electron", async () => ({
  nativeImage: (await import("./mcpImageNative.fixture")).imageNativeBoundary,
}));
import {
  constrainPrintChroma,
  measurePrintChroma,
} from "../src/main/inpainting/qwenPrintChroma";

function stock(colour: (i: number) => number[]) {
  const image = Buffer.alloc(4096 * 4);
  for (let i = 0; i < 4096; i++) image.set([...colour(i), 255], 4 * i);
  return image;
}
const y = (p: Buffer, i: number) =>
  (29 * p[i] + 150 * p[i + 1] + 77 * p[i + 2] + 128) >> 8;

function paletteOf(source: Buffer) {
  const palette = measurePrintChroma(source);
  if (!palette) throw new Error("Expected measured print");
  return palette;
}

it("matches the measured warm ink without altering the repair's tonal structure", () => {
  const original = stock((i) => {
    const v = 8 + (i % 238);
    return [v - 4, v, v + 2];
  });
  const pixels = Buffer.from(original);
  pixels.set([70, 81, 98, 255, 32, 43, 52, 255, 253, 251, 255, 255], 20);
  const light = [20, 24, 28].map((i) => y(pixels, i));
  const palette = paletteOf(original);
  expect(constrainPrintChroma(original, pixels, palette)).toBe(true);
  expect(pixels.subarray(0, 20)).toEqual(original.subarray(0, 20));
  expect(pixels.subarray(32)).toEqual(original.subarray(32));
  for (const [n, i] of [20, 24, 28].entries()) {
    expect(Math.abs(y(pixels, i) - light[n])).toBeLessThanOrEqual(1);
    expect(pixels[i + 1] - pixels[i]).toBeLessThanOrEqual(4);
    expect(pixels[i + 2] - pixels[i + 1]).toBeLessThanOrEqual(2);
    expect(pixels[i + 3]).toBe(255);
  }
});

it("leaves authentic ink colours intact, including at brightnesses with sparse samples", () => {
  const original = stock((i) => (i < 2048 ? [12, 16, 18] : [232, 236, 238]));
  const palette = paletteOf(original);
  const pixels = Buffer.from(original);
  pixels.set([110, 114, 116, 255], 40);
  expect(constrainPrintChroma(original, pixels, palette)).toBe(false);
  pixels.set([85, 70, 101, 132], 40);
  expect(constrainPrintChroma(original, pixels, palette)).toBe(true);
  expect(pixels[40] - pixels[41]).toBe(-4);
  expect(pixels[43]).toBe(132);
});

it("defers saturated, mixed, translucent or single-colour artwork", () => {
  expect(measurePrintChroma(stock(() => [0, 24, 83]))).toBeUndefined();
  const mixed = stock((i) => {
    const v = 40 + ((i >> 1) % 170);
    return i % 2 ? [v - 9, v, v + 9] : [v + 9, v, v - 9];
  });
  expect(measurePrintChroma(mixed)).toBeUndefined();
  const transparent = stock((i) => [
    3 + (i % 127),
    4 + (i % 127),
    4 + (i % 127),
  ]);
  transparent[3] = 0;
  expect(measurePrintChroma(transparent)).toBeUndefined();
  expect(measurePrintChroma(stock(() => [15, 17, 19]))).toBeUndefined();
});

it("removes even isolated chroma from an exact greyscale scan", () => {
  const original = stock((i) => Array(3).fill(i % 256));
  const pixels = Buffer.from(original);
  pixels.set([90, 105, 127, 255], 28);
  const palette = paletteOf(original);
  expect(palette).toBe("grey");
  expect(constrainPrintChroma(original, pixels, palette)).toBe(true);
  expect(pixels[28]).toBe(pixels[29]);
  expect(pixels[29]).toBe(pixels[30]);
  expect(constrainPrintChroma(original, pixels, palette)).toBe(false);
});

it("constrains both decoded pixels and a later native screen pass before publishing the PNG", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qwen-print-colour-"));
  const original = stock((i) => {
    const g = 20 + (i % 190);
    return [g - 3, g, g + 2];
  });
  const predicted = Buffer.from(original);
  predicted.set([71, 82, 95, 255], 36);
  const size = { width: 64, height: 64 };
  const input = nativeImage.createFromBitmap(original, size);
  const image = nativeImage.createFromBitmap(predicted, size);
  const out = join(dir, "page.png"),
    signal = new AbortController().signal;
  try {
    await writeNativeCrop(out, image, original, signal);
    const direct = await readFile(out);
    const result = nativeImage.createFromBuffer(direct).toBitmap();
    expect(result[36] - result[37]).toBe(-3);
    expect(result[38] - result[37]).toBe(2);
    await writeNativeCrop(out, input, original, signal, (staged) =>
      writeFile(staged, image.toPNG()),
    );
    expect(
      nativeImage.createFromBuffer(await readFile(out)).toBitmap(),
    ).toEqual(result);
    const colourPage = Buffer.from(original);
    colourPage.set([20, 125, 210, 255], 0);
    await writeNativeCrop(out, input, colourPage, signal, (staged) =>
      writeFile(staged, image.toPNG()),
    );
    expect(
      nativeImage.createFromBuffer(await readFile(out)).toBitmap(),
    ).toEqual(predicted);
  } finally {
    await rm(out, { force: true });
    await rmdir(dir);
  }
});
