import { controlLaunch, runtime } from "./qwenControlCrop.fixture";
import { originalViewSampling } from "../src/main/inpainting/qwenNativeReference";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { nativeImage } from "electron";
import { QwenSubstrate } from "../src/main/inpainting/qwenSubstrate";
import { QwenImageWorker } from "../src/main/inpainting/qwenImageWorker";

it("keeps the source pixel scale for a small sound on a shaded balloon contour and checks the withheld paper", async () => {
  const size = { width: 104, height: 100 },
    box = { x: 35, y: 32, w: 30, h: 32 };
  const pixels = Buffer.alloc(4 * size.width * size.height, 255),
    stencil = new Uint8Array(size.width * size.height);
  for (let y = 0; y < size.height; y++)
    for (let x = 0; x < size.width; x++) {
      const i = y * size.width + x;
      if (x > y) pixels.fill(201, 4 * i, 4 * i + 3);
      if (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h)
        stencil[i] = 1;
    }
  const source = nativeImage.createFromBitmap(pixels, size);
  const inputs = { ...size, original: pixels, source, stencil, inkBounds: box };
  const substrate = new QwenSubstrate("prior"),
    signal = new AbortController().signal;
  const restore = vi.spyOn(substrate, "restore").mockResolvedValue(source);
  try {
    expect(
      await substrate.restoreSoundBoundary("sound:アッ", inputs, signal),
    ).toBe(source);
    expect(restore.mock.calls[0][3]).toBe(true);
    restore.mockResolvedValue(
      nativeImage.createFromBitmap(Buffer.alloc(pixels.length, 120), size),
    );
    expect(
      await substrate.restoreSoundBoundary("sound:アッ", inputs, signal),
    ).toBeUndefined();
    expect(
      await substrate.restoreSoundBoundary("brush", inputs, signal),
    ).toBeUndefined();
    expect(restore).toHaveBeenCalledTimes(2);
  } finally {
    restore.mockRestore();
    await substrate.dispose();
  }
});

it.each([true, false])(
  "publishes measured title stock without starting diffusion (CUDA control %s)",
  async (withControl) => {
    const directory = await mkdtemp(join(tmpdir(), "qwen-title-stock-"));
    const launch = controlLaunch();
    const worker = new QwenImageWorker({
      executable: "unused",
      env: {},
      gpuUuid: "unused",
      models: launch.models,
      control: withControl ? launch : undefined,
    });
    const size = { width: 64, height: 64 };
    const pixels = Buffer.alloc(4 * size.width * size.height, 255);
    const image = nativeImage.createFromBitmap(pixels, size);
    for (let i = 0; i < pixels.length; i += 4) pixels.fill(144, i, i + 3);
    const filled = nativeImage.createFromBitmap(pixels, size);
    const restore = vi
      .spyOn(QwenSubstrate.prototype, "restoreSelectedStock")
      .mockResolvedValue(filled);
    const request = {
      input: join(directory, "input.png"),
      mask: join(directory, "mask.png"),
      output: join(directory, "output.png"),
      maxPixels: 4096,
      maskPadding: 0,
      strength: 1,
      steps: 8,
      illustratedTitle: "isolated-title-stock" as const,
    };
    try {
      await Promise.all([
        writeFile(request.input, image.toPNG()),
        writeFile(request.mask, image.toPNG()),
      ]);
      await worker.inpaint(request, new AbortController().signal);
      expect(restore).toHaveBeenCalledOnce();
      expect(
        nativeImage.createFromBuffer(await readFile(request.output)).toBitmap(),
      ).toEqual(filled.toBitmap());
    } finally {
      restore.mockRestore();
      await worker.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("extends a registered title's condition while preserving its separate paste mask", async () => {
  const width = 64,
    height = 64,
    stencil = new Uint8Array(width * height);
  for (let y = 18; y < 46; y++) stencil.fill(1, y * width + 18, y * width + 46);
  const source = nativeImage.createFromBitmap(
    Buffer.alloc(4 * width * height, 255),
    { width, height },
  );
  const substrate = new QwenSubstrate("prior");
  const restore = vi
    .spyOn(substrate, "restoreStencil")
    .mockResolvedValue(source);
  expect(
    await substrate.restoreSelectedStock(
      "isolated-title-stock",
      source,
      stencil,
      "title",
      new AbortController().signal,
    ),
  ).toBe(source);
  expect(restore.mock.calls[0][1][32 * width + 17]).toBe(1);
  expect(stencil[32 * width + 17]).toBe(0);
  expect(
    substrate.restoreSelectedStock(
      "sound:タ",
      source,
      stencil,
      "sound",
      new AbortController().signal,
    ),
  ).toBeUndefined();
  expect(
    substrate.restoreSelectedStock(
      false,
      source,
      stencil,
      "other",
      new AbortController().signal,
    ),
  ).toBeUndefined();
});

it.each([
  { top: 96, bottom: 127, right: 408, extend: true },
  { top: 0, bottom: 31, right: 408, extend: true },
  { top: 50, bottom: 84, right: 408, extend: false },
  { top: 96, bottom: 127, right: 120, extend: false },
])(
  "uses edge extension $extend for a credit from row $top through $bottom and column $right",
  async ({ top, bottom, right, extend }) => {
    const size = { width: 512, height: 128 },
      bitmap = Buffer.alloc(size.width * size.height * 4, 255),
      mask = Buffer.alloc(bitmap.length, 0);
    for (let y = 0; y < size.height; y++)
      for (let x = 0; x < size.width; x++) {
        const pos = 4 * (y * size.width + x);
        bitmap[pos + 2] = y === 0 ? 255 : y === 127 ? 128 : 0;
        mask[pos + 3] = 255;
        if (y >= top && y <= bottom && x >= 6 && x <= right)
          mask.fill(255, pos, pos + 3);
      }
    const source = nativeImage.createFromBitmap(bitmap, size),
      stencil = nativeImage.createFromBitmap(mask, size);
    const substrate = new QwenSubstrate("prior");
    runtime.run.mockImplementationOnce(async (input) => {
      const data = input.image.data;
      expect(data[0]).toBe(extend ? 1 : 0);
      expect(data[511 * 512]).toBeCloseTo(extend ? 128 / 255 : 0);
      return {
        restored: {
          data: new Float32Array(3 * 512 * 512),
          dims: [1, 3, 512, 512],
          dispose: runtime.disposeTensor,
        },
      };
    });
    try {
      await substrate.restore(source, stencil, new AbortController().signal);
    } finally {
      await substrate.dispose();
    }
  },
);

it.each([
  "ruled-sound-shadow",
  "balloon-edge-reading",
  "duotone-overlay",
] as const)(
  "restores only the selected native print on a %s crop",
  async (hint) => {
    const size = { width: 80, height: 96 },
      stencil = new Uint8Array(size.width * size.height),
      bytes = Buffer.alloc(stencil.length * 4, 255);
    for (let y = 34; y < 48; y++)
      for (let x = 28; x < 42; x++) {
        const i = y * size.width + x;
        stencil[i] = 1;
        bytes.set([34, 42, 218, 255], 4 * i);
      }
    const source = nativeImage.createFromBitmap(bytes, size),
      substrate = new QwenSubstrate("fixture"),
      repaired = nativeImage.createFromBitmap(
        Buffer.alloc(512 * 512 * 4, 255),
        { width: 512, height: 512 },
      );
    const native = vi.spyOn(substrate, "restore").mockResolvedValue(repaired);
    try {
      const result = await substrate.restoreSelectedStock(
        hint,
        source,
        stencil,
        "sample",
        new AbortController().signal,
      );
      expect(result?.getSize()).toEqual({ width: 80, height: 96 });
      expect(native).toHaveBeenCalledOnce();
      expect(result?.toBitmap().subarray(0, 4)).toEqual(bytes.subarray(0, 4));
    } finally {
      await substrate.dispose();
    }
  },
);

it.each(["effect", "brush"] as const)(
  "keeps the measured native resolution for %s reconstruction",
  (referenceEdit) => {
    const size = { width: 32, height: 32 },
      original = Buffer.alloc(32 * 32 * 4, 245),
      stencil = new Uint8Array(32 * 32),
      prior = nativeImage.createFromBitmap(original, { ...size });
    const crop = {
      size,
      condition: stencil,
      prior,
      prefix: "test",
      sourceReference: true,
      registered: false,
      referenceEdit,
    };
    expect(
      originalViewSampling(crop, { ...size, stencil, original }, false)
        .maxUpscale,
    ).toBeUndefined();
  },
);
