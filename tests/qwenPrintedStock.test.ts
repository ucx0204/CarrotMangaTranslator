import { makeControlCrop } from "./qwenControlCrop.fixture";
import { nativeImage } from "electron";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  illustrationHint,
  qwenSamplingSizes,
} from "../src/main/inpainting/qwenControlSampling";
import {
  localWhitePaperBanks,
  measuredBurstPaperBank,
} from "../src/main/inpainting/qwenPaperBank";
import { expect, it } from "vitest";
import { nativePrintedStock } from "../src/main/inpainting/qwenPrintedStock";
import { restoreStoneTexture } from "../src/main/inpainting/qwenStoneTexture";
import { QwenNativeReference } from "../src/main/inpainting/qwenNativeReference";

it.each([
  ["roughStone", 16],
  ["facetedFrame", 28],
] as const)(
  "writes the verified sampling count for %s to the worker request",
  async (referenceEdit, steps) => {
    const dir = await mkdtemp(join(tmpdir(), "qwen-print-sampling-"));
    const crop = makeControlCrop(),
      size = { width: 64, height: 64 };
    try {
      const args = await crop.argumentsFor(
        {
          referenceEdit,
          size,
          prefix: join(dir, "reference"),
          condition: new Uint8Array(64 * 64),
          prior: nativeImage.createFromBitmap(
            Buffer.alloc(64 * 64 * 4, 255),
            size,
          ),
          sourceReference: true,
          registered: false,
        },
        size,
        join(dir, "page.png"),
        join(dir, "result.png"),
      );
      const config = JSON.parse(await readFile(args[args.length - 1], "utf8"));
      expect(config).toMatchObject({ steps, pairedReference: true, cfg: 2.5 });
    } finally {
      await crop.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("uses a restored prior for broad two-tone display type and preserves ordinary caption conditioning", () => {
  const width = 440,
    height = 310;
  const original = Buffer.alloc(width * height * 4, 249);
  const stencil = new Uint8Array(width * height).fill(1);
  const request = {
    input: "",
    mask: "",
    output: "",
    maskPadding: 0,
    maxPixels: width * height,
    steps: 8,
    strength: 1,
    illustratedTitle: "caption" as const,
  };
  const hint = () =>
    illustrationHint(request, { original, stencil, width, height });
  for (let y = 18; y < 280; y++)
    for (let x = 14; x < 415; x++) {
      if (x % 85 >= 57) continue;
      const pos = 4 * (y * width + x);
      original.fill(x < 220 ? 10 : 96, pos, pos + 3);
    }
  expect(hint()).toBe(false);
  for (let i = 0; i < original.length; i += 4)
    if (original[i] === 96) original[i + 2] = 165;
  expect(hint()).toBe("caption");
  original.fill(15);
  expect(hint()).toBe("caption");
  stencil.fill(0);
  expect(hint()).toBe("caption");
});

function crop() {
  const size = { width: 192, height: 240 },
    pixels = Buffer.alloc(size.width * size.height * 4, 255);
  const mask = new Uint8Array(size.width * size.height);
  const pixel = (x: number, y: number, value: number, selected = false) => {
    const at = y * size.width + x;
    pixels.fill(value, 4 * at, 4 * at + 3);
    if (selected) mask[at] = 1;
  };
  const detect = () => nativePrintedStock(pixels, mask, size);
  return { size, pixels, mask, pixel, detect };
}

it("preserves both surviving frame edges and only marks the hollow lettering in the native references", async () => {
  const { size, pixels, mask, pixel, detect } = crop();
  for (const left of [60, 99])
    for (const top of [24, 60, 96, 132, 168]) {
      for (let y = 0; y < 27; y++)
        for (let x = 0; x < 20; x++)
          pixel(
            left + x,
            top + y,
            Math.min(x, y, 19 - x, 26 - y) < 1 ? 0 : 255,
            true,
          );
    }
  for (let y = 0; y < 225; y++) pixel(45, y, 22);
  expect(detect()).toBeUndefined();
  for (let y = 0; y < 225; y++) pixel(136 + Math.floor((y - 120) / 12), y, 12);
  expect(detect()).toBe("facetedFrame");
  const dir = await mkdtemp(join(tmpdir(), "qwen-native-frame-"));
  const input = join(dir, "source.png");
  const stencil = join(dir, "stencil.png");
  const output = join(dir, "finished.png");
  const source = nativeImage.createFromBitmap(pixels, size);
  const reference = new QwenNativeReference({
    diffusion: "Q8",
    text: "Q4",
    vision: "mmproj",
    vae: "vae",
    prior: "lama",
  });
  try {
    const argumentsFor = await reference.prepare(
      source,
      mask,
      {
        input,
        mask: stencil,
        output,
        steps: 28,
        strength: 1,
        maxPixels: 896 ** 2,
        maskPadding: 0,
      },
      size,
      new AbortController().signal,
    );
    const [config] = await argumentsFor(output);
    expect(JSON.parse(await readFile(config, "utf8")).references).toContain(
      input + ".qwen.png",
    );
    expect(await readFile(input + ".qwen.png")).toEqual(
      source.resize({ ...size, quality: "best" }).toPNG(),
    );
    const marked = nativeImage
      .createFromBuffer(await readFile(stencil + ".qwen.png"))
      .toBitmap();
    const at = (x: number, y: number) => marked[(y * size.width + x) * 4];
    expect([at(59, 24), at(60, 24), at(79, 50), at(80, 50)]).toEqual([
      0, 255, 255, 0,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("matches angular flecks around solid type on pale rock and excludes colour artwork", async () => {
  const { size, pixels, mask, pixel, detect } = crop();
  for (let y = 0; y < size.height; y++)
    for (let x = 0; x < size.width; x++)
      if ((x + 3 * y) % 13 === 0) pixel(x, y, 187);
  for (const top of [48, 94, 140])
    for (let y = 0; y < 12; y++)
      for (let x = 0; x < 52; x++) pixel(67 + x, top + y, 12, true);
  for (const top of [40, 73, 84, 119, 130, 164])
    for (const x of [64, 77, 92, 108, 119]) {
      pixel(x, top, 35);
      pixel(x, top + 1, 48);
      pixel(x, top + 2, 72);
    }
  expect(detect()).toBe("roughStone");
  const source = nativeImage.createFromBitmap(pixels, size);
  const prepared = await makeControlCrop().prepare(
    source,
    mask,
    "source.png",
    new AbortController().signal,
    "mask.png",
  );
  expect(prepared.referenceEdit).toBe("roughStone");
  expect(prepared.nativeSourceMask).toBe("mask.png");
  expect(prepared.prior).toBe(source);
  expect(qwenSamplingSizes(prepared)).toEqual([896, 768, 640, 512]);
  const decoded = Buffer.from(pixels);
  for (let i = 0; i < mask.length; i++)
    if (mask[i]) decoded.fill(125, 4 * i, 4 * i + 3);
  const native = new QwenNativeReference({
    diffusion: "Q8",
    vae: "vae",
    text: "Q4",
    prior: "lama",
  });
  expect(
    native.artworkView({ ...size, original: pixels, stencil: mask }),
  ).toBeUndefined();
  const restored = native.finish(
    { ...size, original: pixels, stencil: mask },
    decoded,
  );
  expect(restored.subarray(0, size.width * 4 * 35)).toEqual(
    pixels.subarray(0, size.width * 4 * 35),
  );
  expect(restored[4 * (size.width * 51 + 87)]).toBeGreaterThan(125);
  expect(restored).not.toEqual(decoded);
  for (let i = 0; i < pixels.length; i += 4) pixels[i] = 120;
  expect(detect()).toBeUndefined();
  expect(
    native.finish({ ...size, original: pixels, stencil: mask }, decoded),
  ).toBe(decoded);
});

it("uses the decoded drawing when there is no exposed stone to sample", () => {
  const { size, pixels, mask } = crop();
  const decoded = Buffer.from(pixels);
  expect(restoreStoneTexture(pixels, decoded, mask, size)).toBe(decoded);
  mask.fill(1);
  expect(restoreStoneTexture(pixels, decoded, mask, size)).toBe(decoded);
});

it("keeps native balloon ink and pairs cloth folds with the registered source stencil", async () => {
  const { size, pixels, mask, pixel, detect } = crop();
  for (let y = 0; y < size.height; y++)
    for (let x = 0; x < size.width; x++)
      if ((x + 3 * y) % 5 < 2) pixel(x, y, 180);
  for (const left of [63, 104])
    for (const top of [29, 58, 87, 116, 145, 174]) {
      for (let y = -3; y < 16; y++)
        for (let x = -3; x < 18; x++) pixel(left + x, top + y, 255);
      for (let y = 0; y < 13; y++)
        for (let x = 0; x < 15; x++)
          pixel(left + x, top + y, x < 8 ? 18 : 255, true);
      for (let x = 0; x < 15; x++) pixel(left + x, top + 6, 22, true);
    }
  for (let y = 14; y < 221; y++) pixel(54, y, 22, y >= 78 && y < 84);
  expect(detect()).toBe("drawnCloth");
  const native = new QwenNativeReference({
    diffusion: "Q8",
    text: "Q4",
    prior: "lama",
    vae: "vae",
    vision: "mmproj",
  });
  const view = native.artworkView({
    ...size,
    original: pixels,
    stencil: mask,
  });
  expect(view?.weights?.[80 * size.width + 54]).toBe(0);
  expect(view?.weights?.[90 * size.width + 64]).toBe(1);
  expect(qwenSamplingSizes(view)).toEqual([896, 768, 640, 512]);
  const dir = await mkdtemp(join(tmpdir(), "qwen-native-cloth-"));
  const input = join(dir, "source.png"),
    stencil = join(dir, "stencil.png"),
    output = join(dir, "finished.png");
  const source = nativeImage.createFromBitmap(pixels, size);
  try {
    const prepare = await native.prepare(
      source,
      mask,
      {
        input,
        mask: stencil,
        output,
        steps: 28,
        strength: 1,
        maxPixels: 896 ** 2,
        maskPadding: 0,
      },
      size,
      new AbortController().signal,
    );
    const [config] = await prepare(output);
    const { generation } = JSON.parse(await readFile(config, "utf8"));
    expect(generation["sample.scheduler"]).toBe("simple");
    expect(generation.negative_prompt).toContain("broken balloon border");
    expect(await readFile(input + ".qwen.png")).toEqual(
      source.resize({ ...size, quality: "best" }).toPNG(),
    );
    const bitmap = nativeImage
      .createFromBuffer(await readFile(stencil + ".qwen.png"))
      .toBitmap();
    expect(bitmap[(32 * size.width + 60) * 4]).toBe(255);
    expect(bitmap[(32 * size.width + 59) * 4]).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([false, true])(
  "uses both native references for a caption crossing a screened edge (mirrored %s)",
  async (mirrored) => {
    const { size, pixels, mask, pixel, detect } = crop();
    const at = (x: number) => (mirrored ? size.width - 1 - x : x);
    for (let y = 36; y < 188; y++)
      for (let x = 102; x < 156; x++) {
        pixel(at(x), y, x === 102 || (3 * x + y) % 7 === 0 ? 75 : 221);
      }
    for (const top of [42, 71, 100, 129, 158])
      for (let y = 0; y < 5; y++) pixel(at(54), top + y, 52, true);
    for (const top of [42, 71, 100, 129, 158])
      for (let y = 0; y < 17; y++)
        for (let x = 0; x < 18; x++)
          pixel(at(75 + x), top + y, x < 5 || y === 8 ? 24 : 255, true);
    expect(detect()).toBe("paperEdgeCaption");
    const prepared = await makeControlCrop().prepare(
      nativeImage.createFromBitmap(pixels, size),
      mask,
      "source.png",
      new AbortController().signal,
      "mask.png",
      "caption",
    );
    expect(prepared).toMatchObject({
      referenceEdit: "paperEdgeCaption",
      nativeSourceMask: "mask.png",
      material: { kind: "caption" },
    });
    expect(qwenSamplingSizes(prepared)[0]).toBe(896);
    const clippedSize = { width: size.width - 45, height: size.height };
    const start = mirrored ? 0 : 45;
    const clippedSource = nativeImage
      .createFromBitmap(pixels, size)
      .crop({ x: start, y: 0, ...clippedSize });
    const clippedMask = Uint8Array.from(
      { length: clippedSize.width * clippedSize.height },
      (_, i) =>
        mask[
          Math.floor(i / clippedSize.width) * size.width +
            start +
            (i % clippedSize.width)
        ],
    );
    expect(
      nativePrintedStock(clippedSource.toBitmap(), clippedMask, clippedSize),
    ).toBeUndefined();
    for (let y = 36; y < 188; y++)
      for (let x = 27; x < 50; x++) pixel(at(x), y, 212);
    expect(detect()).toBeUndefined();
  },
);

it("samples two independent near-white banks and keeps nearer genuine burst rays", () => {
  const w = 80,
    h = 80,
    n = w * h,
    pix = Buffer.alloc(n * 4, 255),
    distances = new Float32Array(n).fill(13);
  const white = localWhitePaperBanks(pix, distances, (i) => 4 * i, w, h);
  expect(white(40 * w + 40)).toBe(true);
  expect(white(40 * w + 40)).toBe(true);
  pix.fill(204);
  expect(white(10 * w + 9)).toBe(false);
  expect(white(10 * w + 9)).toBe(false);
  const ink = new Uint8Array(n),
    letters = new Uint8Array(n),
    fill = new Uint8Array(n).fill(1),
    separated = new Uint8Array(n);
  const bank = new Uint8Array(n).fill(1),
    gray = new Uint8Array(n).fill(252);
  for (let y = 15; y < 67; y++) {
    ink[y * w + 55] = 1;
    ink[y * w + 33] = 1;
    letters[y * w + 33] = 1;
    separated[y * w + 33] = 1;
  }
  const measured = measuredBurstPaperBank(
    ink,
    letters,
    fill,
    separated,
    bank,
    gray,
    w,
    h,
  );
  expect(measured?.[40 * w + 55]).toBe(0);
  expect(fill[40 * w + 54]).toBe(0);
  expect(fill[40 * w + 34]).toBe(1);
  gray.fill(210);
  expect(
    measuredBurstPaperBank(ink, letters, fill, separated, bank, gray, w, h),
  ).toBeUndefined();
});
