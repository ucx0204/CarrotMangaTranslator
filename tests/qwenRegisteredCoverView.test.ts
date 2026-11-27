import { runtime, makeControlCrop } from "./qwenControlCrop.fixture";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeImage } from "electron";
import { expect, it, vi } from "vitest";
import {
  finishMeasuredPrint,
  qwenReferenceSize,
} from "../src/main/inpainting/qwenCoverViews";
import type { FluxWorkerRequest } from "../src/main/inpainting/fluxWorkerTypes";
import { repairObliqueJacket } from "../src/main/inpainting/qwenJacketView";
import { QwenJacketVerifier } from "../src/main/inpainting/qwenJacketVerifier";
import { ensureQwenJacketVerifier } from "../src/main/inpainting/qwenImageAssets";
import * as downloads from "../src/main/runtimeSupport/modelDownloads";

import {
  qwenSamplingSizes,
  referenceEditMode,
} from "../src/main/inpainting/qwenControlSampling";
import { supportsQwenControlRuntime } from "../src/main/inpainting/qwenControlRuntime";
import { QwenSubstrate } from "../src/main/inpainting/qwenSubstrate";
import { compactSoundCondition } from "../src/main/inpainting/qwenPrintedReference";

it("uses a cleared pale gradient for a small dark effect unless an adjacent contour crosses its bank", async () => {
  const width = 100,
    height = 90;
  const pixels = Buffer.alloc(4 * width * height, 248);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  const stencil = new Uint8Array(width * height);
  for (let y = 24; y < 52; y++)
    for (let x = 24; x < 58; x++) {
      const i = y * width + x;
      stencil[i] = 1;
      const phase = x % 10;
      pixels.fill(phase < 2 ? 22 : phase === 2 ? 130 : 248, i * 4, i * 4 + 3);
    }
  const measure = () =>
    compactSoundCondition(
      nativeImage.createFromBitmap(pixels, { width, height }),
      stencil,
    );
  expect(measure()?.[40 * width + 38]).toBe(1);
  const source = () => nativeImage.createFromBitmap(pixels, { width, height });
  const substrate = new QwenSubstrate("prior");
  const neural = vi
    .spyOn(substrate, "restoreStencil")
    .mockResolvedValue(source());
  const restore = () =>
    substrate.restoreSelectedStock(
      "sound:タ",
      source(),
      stencil,
      "effect",
      new AbortController().signal,
    );
  expect((await restore())?.toBitmap()[4 * (40 * width + 30)]).toBe(248);
  expect(neural).not.toHaveBeenCalled();
  const boundary = 4 * (40 * width + 61);
  pixels.fill(180, boundary, boundary + 3);
  expect(await restore()).toBeDefined();
  expect(neural).toHaveBeenCalledOnce();
  neural.mockRestore();
  for (let y = 10; y < 70; y++)
    pixels.fill(15, 4 * (y * width + 62), 4 * (y * width + 62) + 3);
  expect(measure()).toBeUndefined();
});

it("conditions compact grayscale effects on the surrounding pen and the erased substrate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qwen-small-printed-effect-"));
  const control = makeControlCrop(),
    signal = new AbortController().signal;
  const size = { width: 128, height: 112 };
  const data = Buffer.alloc(4 * size.width * size.height, 255);
  const stencil = new Uint8Array(size.width * size.height);
  for (let y = 22; y <= 83; y++) {
    for (let x = 28; x < 102; x++) {
      const i = y * size.width + x;
      const selected = x > 42 && x < 79 && y % 20 < 5;
      stencil[i] = Number(selected);
      if (selected || x % 11 < 6)
        data.fill(selected ? 129 : 172, 4 * i, 4 * i + 3);
    }
  }
  const source = nativeImage.createFromBitmap(data, size);
  const restore = vi
    .spyOn(QwenSubstrate.prototype, "restore")
    .mockResolvedValue(source);
  const input = join(dir, "input.png");
  try {
    const prepared = await control.prepare(
      source,
      stencil,
      input,
      signal,
      join(dir, "mask.png"),
      "sound:",
    );
    expect(prepared.compactSound).toBe(true);
    expect(prepared.condition).toEqual(compactSoundCondition(source, stencil));
    expect(prepared.material?.kind).toBe("sound");
    expect(restore).toHaveBeenCalledOnce();
    expect(qwenSamplingSizes(prepared)[0]).toBe(768);
    const write = await control.argumentsFor(
      prepared,
      { width: 128, height: 128 },
      input,
      join(dir, "out.png"),
      signal,
    );
    const config = JSON.parse(await readFile(write[write.length - 1], "utf8"));
    expect(config).toMatchObject({
      referencePrior: true,
      steps: 32,
      cfg: 3,
      seed: 20,
      denoise: 0.58,
    });
    expect(config.referenceEdit).toBeFalsy();
    const paper = Buffer.alloc(data.length, 255);
    for (let i = 0; i < stencil.length; i++) {
      if (stencil[i] || (i % size.width) % 7 === 0)
        paper.fill(stencil[i] ? 129 : 172, 4 * i, 4 * i + 3);
    }
    expect(
      compactSoundCondition(nativeImage.createFromBitmap(paper, size), stencil),
    ).toBeUndefined();
    const coloured = Buffer.from(data);
    for (let i = 0; i < stencil.length; i++) coloured[4 * i] = 55;
    expect(
      compactSoundCondition(
        nativeImage.createFromBitmap(coloured, size),
        stencil,
      ),
    ).toBeUndefined();
    expect(
      compactSoundCondition(source, new Uint8Array(stencil.length)),
    ).toBeUndefined();
  } finally {
    restore.mockRestore();
    await control.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it("checks the installed CUDA driver before choosing the registered colour reference runtime", async () => {
  const signal = new AbortController().signal;
  expect(await supportsQwenControlRuntime(null, signal)).toBe(false);
  expect(await supportsQwenControlRuntime(7, signal)).toBe(false);
  if (process.platform !== "win32" || process.arch !== "x64") {
    expect(await supportsQwenControlRuntime(8.9, signal)).toBe(false);
    return;
  }
  for (const [report, expected] of [
    ["CUDA UMD version : 13.1", true],
    ["CUDA version : 12.9", false],
    ["Driver version: 589.00", false],
  ] as const) {
    runtime.screen.mockResolvedValueOnce({ stdout: report });
    expect(await supportsQwenControlRuntime(7.5, signal)).toBe(expected);
    expect(runtime.screen).toHaveBeenLastCalledWith(
      "nvidia-smi",
      ["--version"],
      {
        signal,
        windowsHide: true,
        timeout: 5000,
      },
    );
  }
});

it("samples measured art and original print at one crop size and validates the returned coordinates", async () => {
  const root = await mkdtemp(join(tmpdir(), "qwen-display-pair-")),
    control = makeControlCrop();
  const size = { width: 620, height: 440 },
    pixels = Buffer.alloc(size.width * size.height * 4, 255);
  const image = nativeImage.createFromBitmap(pixels, size),
    stencil = new Uint8Array(size.width * size.height).fill(1);
  const source = join(root, "scan.png"),
    mask = join(root, "type.png"),
    signal = new AbortController().signal;
  const view = { x: 22, y: 40, w: 568, h: 381 };
  try {
    runtime.screen.mockResolvedValueOnce({ stdout: "unchanged" });
    expect(
      await control.registration.displayTitleView(source, mask, size, signal),
    ).toBeUndefined();
    runtime.screen.mockResolvedValueOnce({
      stdout: JSON.stringify({ ...view, x: 80 }),
    });
    await expect(
      control.registration.displayTitleView(source, mask, size, signal),
    ).rejects.toThrow("범위를");
    runtime.screen.mockResolvedValueOnce({ stdout: JSON.stringify(view) });
    const crop = await control.prepare(
      image,
      stencil,
      source,
      signal,
      mask,
      "layered-title:日本語",
    );
    expect(crop.pairedWindow).toMatchObject({
      ...view,
      guide: source + ".display-guide.png",
    });
    const target = { width: 800, height: 544 };
    const args = await control.argumentsFor(
      crop,
      target,
      source,
      join(root, "edited.png"),
      signal,
    );
    const config = JSON.parse(await readFile(args[args.length - 1], "utf8"));
    expect(config).toMatchObject({
      referenceEdit: true,
      pairedReference: true,
      steps: 25,
      cfg: 1,
      seed: 20,
    });
    expect(config.prompt).toContain("second reference");
    expect(runtime.screen).toHaveBeenLastCalledWith(
      "python",
      expect.arrayContaining([
        source,
        source + ".display-guide.png",
        config.image,
        config.prior,
        config.mask,
        "800",
        "544",
        "display",
      ]),
      expect.objectContaining({ signal }),
    );
  } finally {
    await control.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("uses a measured inset as an upright edit and projects its result back once", async () => {
  const root = await mkdtemp(join(tmpdir(), "qwen-measured-book-"));
  const control = makeControlCrop(),
    signal = new AbortController().signal;
  const size = { width: 195, height: 160 },
    original = Buffer.alloc(size.width * size.height * 4, 255);
  const stencil = new Uint8Array(size.width * size.height);
  for (let y = 55; y < 103; y++)
    for (let x = 42; x < 147; x++) {
      const i = y * size.width + x;
      stencil[i] = 255;
      original[i * 4] = 80;
    }
  const source = nativeImage.createFromBitmap(original, size);
  const inputs = { ...size, source, stencil, original };
  const request = {
    input: join(root, "scan.png"),
    mask: join(root, "type.png"),
    output: join(root, "page.png"),
    steps: 40,
    strength: 1,
    maxPixels: 1024 ** 2,
    maskPadding: 0,
  };
  const plane = vi.spyOn(control.registration, "processJacketPlane");
  const edit = vi.fn(async (crop: FluxWorkerRequest) => {
    expect(crop.input).toMatch(/book\.png$/u);
    expect(crop.mask).toMatch(/ink\.png$/u);
    expect(crop.illustratedTitle).toBe("upright-jacket");
    await writeFile(crop.output, source.toPNG());
  });
  try {
    for (const req of [
      { ...request, speechBubble: true },
      { ...request, illustratedTitle: true },
    ]) {
      expect(
        await repairObliqueJacket(control, req, inputs, signal, edit),
      ).toBe(false);
    }
    expect(
      await repairObliqueJacket(undefined, request, inputs, signal, edit),
    ).toBe(false);
    expect(
      await repairObliqueJacket(
        control,
        request,
        { ...inputs, stencil: new Uint8Array(stencil.length) },
        signal,
        edit,
      ),
    ).toBe(false);
    expect(
      await repairObliqueJacket(
        control,
        request,
        { ...inputs, height: 130 },
        signal,
        edit,
      ),
    ).toBe(false);
    expect(plane).not.toHaveBeenCalled();
    plane.mockResolvedValueOnce(false);
    expect(
      await repairObliqueJacket(control, request, inputs, signal, edit),
    ).toBe(false);
    expect(edit).not.toHaveBeenCalled();
    plane.mockImplementation(async (mode, input, mask, dir, active) => {
      expect([input, mask, active]).toEqual([
        request.input,
        request.mask,
        signal,
      ]);
      if (mode === "compose")
        await writeFile(
          join(dir, "native.png"),
          await readFile(join(dir, "edited.png")),
        );
      return true;
    });
    expect(
      await repairObliqueJacket(control, request, inputs, signal, edit),
    ).toBe(true);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(await readFile(request.output)).toEqual(source.toPNG());
    await expect(readFile(edit.mock.calls[0][0].output)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    plane.mockRestore();
    await control.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("uses the full original upright book as one diffusion reference at its measured aspect ratio", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qwen-upright-reference-"));
  const crop = makeControlCrop(),
    size = { width: 349, height: 512 };
  const signal = new AbortController().signal,
    source = join(dir, "book.png");
  const image = nativeImage.createFromBitmap(
    Buffer.alloc(4 * size.width * size.height, 255),
    size,
  );
  const ink = new Uint8Array(size.width * size.height);
  ink.fill(1, 203 * size.width, 344 * size.width);
  try {
    const prepared = await crop.prepare(
      image,
      ink,
      source,
      signal,
      join(dir, "ink.png"),
      "upright-jacket",
    );
    expect(prepared.pairedWindow).toEqual({
      x: 0,
      y: 0,
      w: size.width,
      h: size.height,
      guide: source,
    });
    const sides = qwenSamplingSizes(prepared);
    const target = qwenReferenceSize(size.width, size.height, sides[0] ** 2);
    expect(target).toEqual({ width: 576, height: 864 });
    runtime.screen.mockResolvedValueOnce({ stdout: "" });
    const args = await crop.argumentsFor(
      prepared,
      target,
      source,
      join(dir, "edited.png"),
      signal,
    );
    const config = JSON.parse(await readFile(args[args.length - 1], "utf8"));
    expect(config).toMatchObject({
      pairedReference: false,
      referenceSource: true,
      referenceEdit: true,
      seed: 20,
      steps: 27,
      cfg: 1,
      denoise: 1,
    });
    expect(config.prompt).toContain("original manga book cover");
  } finally {
    await crop.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it("conditions the Qwen edit on reconstructed paper only where the selected accents interrupt a rule", async () => {
  const size = { width: 132, height: 92 };
  const dir = await mkdtemp(join(tmpdir(), "qwen-reaction-strokes-"));
  const clean = Buffer.alloc(4 * size.width * size.height, 255);
  const draw = (pixels: Buffer, x: number, y: number, value: number) => {
    const offset = 4 * (y * size.width + x);
    pixels.fill(value, offset, offset + 3);
  };
  for (let y = 40; y < 70; y++)
    for (let x = 0; x < size.width; x++)
      draw(clean, x, y, y < 43 ? 30 : 151 + ((x + y) % 36));
  function drawAccents(bitmap: Buffer, stencil: Uint8Array, count: number) {
    for (const left of [22, 61, 100].slice(0, count)) {
      for (let y = 28; y < 58; y++)
        for (let x = left - 5; x < left + 13; x++) {
          const ink = y >= 33 && y < 53 && x >= left && x < left + 8;
          draw(bitmap, x, y, ink ? 18 : 255);
          if (ink) stencil[y * size.width + x] = 1;
        }
    }
  }
  const control = makeControlCrop();
  const signal = new AbortController().signal;
  try {
    for (const [withRule, count] of [
      [false, 3],
      [true, 2],
      [true, 3],
    ] as const) {
      const bitmap = withRule
        ? Buffer.from(clean)
        : Buffer.alloc(clean.length, 255);
      const stencil = new Uint8Array(size.width * size.height);
      drawAccents(bitmap, stencil, count);
      const prefix = join(dir, "input");
      const crop = await control.prepare(
        nativeImage.createFromBitmap(bitmap, size),
        stencil,
        prefix,
        signal,
        prefix + ".mask.png",
        "sound:",
      );
      if (!withRule || count < 3) {
        expect(crop.pairedWindow).toBeUndefined();
        continue;
      }
      expect(crop.pairedWindow).toMatchObject({
        radius: 5,
        mask: prefix + ".mask.png",
      });
      const args = await control.argumentsFor(
        crop,
        size,
        prefix,
        join(dir, "output.png"),
      );
      const config = JSON.parse(await readFile(args[args.length - 1], "utf8"));
      expect(config).toMatchObject({
        pairedReference: true,
        seed: 20,
        steps: 25,
        cfg: 1,
      });
      expect(config.prompt).toContain("second reference");
      expect(runtime.screen).toHaveBeenCalledWith(
        "python",
        expect.arrayContaining([
          prefix,
          prefix + ".mask.png",
          config.image,
          config.prior,
          config.mask,
        ]),
        expect.objectContaining({ windowsHide: true }),
      );
    }
  } finally {
    await control.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it("verifies the pinned miniature jacket line detector through the normal asset gateway", async () => {
  const signal = new AbortController().signal;
  const remote = vi
    .spyOn(downloads, "ensureRemoteFile")
    .mockResolvedValue("checked/manga_det.onnx");
  try {
    await expect(
      ensureQwenJacketVerifier({ modelDir: "checked", signal }),
    ).resolves.toBe("checked/manga_det.onnx");
    expect(remote).toHaveBeenCalledWith(
      expect.objectContaining({
        signal,
        fileName: "manga_det.onnx",
        expectedTotalBytes: 1_816_958,
        minimumBytes: 1_816_958,
        maximumBytes: 1_816_958,
        expectedSha256:
          "97c434ae8deaad83513fb132b605d5085a3af8ffac2cb15e2aa096815c206172",
        url: expect.stringContaining(
          "d65838996a00ef6b1c73ca3a700d7a8c5fbbef8a",
        ),
      }),
    );
  } finally {
    remote.mockRestore();
  }
});

it.each([
  ["masthead:月刊", 0],
  ["masthead:月刊", 56],
  ["lettering", 0],
  ["lettering", 56],
] as const)(
  "merges a small %s print fragment only after the residual score falls (%s)",
  async (hint, remaining) => {
    const dir = await mkdtemp(join(tmpdir(), "qwen-residual-print-"));
    const size = { width: 68, height: 410 },
      view = { x: 15, y: 12, width: 12, height: 10, score: 61, fragment: 22 };
    const bitmap = Buffer.alloc(4 * size.width * size.height, 255);
    const source = nativeImage.createFromBitmap(bitmap, size);
    const control = makeControlCrop(),
      signal = new AbortController().signal;
    const patch = Buffer.alloc(4 * view.width * view.height, 0);
    patch.fill(255, 4 * (view.width * 5 + 5), 4 * (view.width * 5 + 6));
    const mask = nativeImage.createFromBitmap(patch, view);
    vi.spyOn(control.registration, "registerImage").mockResolvedValue(source);
    vi.spyOn(control.registration, "remainingCoverPrint")
      .mockImplementationOnce(async (_input, _mask, _edited, output, mode) => {
        expect(mode).toBe(hint === "lettering" ? "ink-terminal" : "masthead");
        await writeFile(output, mask.toPNG());
        return view;
      })
      .mockResolvedValueOnce(remaining ? { ...view, score: remaining } : null);
    vi.spyOn(control, "restoreReference").mockResolvedValue(
      nativeImage.createFromBitmap(Buffer.alloc(patch.length, 88), view),
    );
    try {
      const result = await finishMeasuredPrint(
        {
          request: {
            input: join(dir, "source.png"),
            mask: join(dir, "mask.png"),
            output: join(dir, "final.png"),
            illustratedTitle: hint,
            steps: 40,
            strength: 1,
            maxPixels: 960 * 960,
            maskPadding: 0,
          },
          control,
          source,
          stencil: new Uint8Array(size.width * size.height),
          decoded: bitmap,
          signal,
          sample: async () => {
            throw Error("A sparse registered fragment uses the native guide");
          },
          sizeFor: () => size,
        },
        { kind: "glowing-print" },
      );
      expect(
        result.toBitmap()[4 * ((view.y + 5) * size.width + view.x + 5)],
      ).toBe(remaining ? 255 : 88);
      expect(
        result.toBitmap()[4 * ((view.y + 5) * size.width + view.x + 4)],
      ).toBe(255);
    } finally {
      await control.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.each([
  ["edition:09 2026 SEP", "edition", "09 2026 SEP"],
  ["masthead:月刊", "mastheadLines", "月刊"],
  ["cover-title:夏の海", "coverTitle", "夏の海"],
  ["jacket-promo:発売中", "promo", "発売中"],
  ["jacket-strap:連載陣", "strap", "連載陣"],
] as const)(
  "passes the selected cover reading to the native edit for %s",
  async (hint, mode, reading) => {
    const dir = await mkdtemp(join(tmpdir(), "qwen-printed-reading-"));
    const size = { width: 70, height: 92 },
      signal = new AbortController().signal;
    const source = nativeImage.createFromBitmap(
      Buffer.alloc(4 * size.width * size.height, 255),
      size,
    );
    const stencil = new Uint8Array(size.width * size.height).fill(1),
      control = makeControlCrop();
    try {
      const prepared = await control.prepare(
        source,
        stencil,
        join(dir, "source"),
        signal,
        undefined,
        hint,
      );
      expect(prepared.referenceEdit).toBe(mode);
      const args = await control.argumentsFor(
        prepared,
        size,
        join(dir, "input.png"),
        join(dir, "output.png"),
      );
      const request = JSON.parse(await readFile(args[args.length - 1], "utf8"));
      expect(request.prompt).toContain(reading);
      expect(request.cfg).toBe(3.5);
    } finally {
      await control.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.each([
  ["jacket:", true],
  ["jacket:", false],
  ["pigment:", true],
  ["pigment:", false],
  ["layered-title:", true],
  ["layered-title:", false],
] as const)(
  "keeps a %s repair only when its selected original line disappears (%s)",
  async (hint, cleared) => {
    const dir = await mkdtemp(join(tmpdir(), "qwen-jacket-repair-"));
    const size = { width: 48, height: 64 };
    const image = (level: number) =>
      nativeImage.createFromBitmap(
        Buffer.alloc(4 * size.width * size.height, level),
        size,
      );
    const source = image(255),
      first = image(184),
      result = image(202);
    const control = makeControlCrop();
    const line = { x: 8, y: 6, w: 14, h: 39 };
    const peer = { x: 32, y: 29, w: 9, h: 10 };
    const stencil = new Uint8Array(size.width * size.height);
    for (let y = line.y; y < line.y + line.h; y++)
      stencil.fill(
        1,
        y * size.width + line.x,
        y * size.width + line.x + line.w,
      );
    vi.spyOn(control.jacketVerifier, "lines")
      .mockResolvedValueOnce([line, peer])
      .mockResolvedValueOnce([line, peer])
      .mockResolvedValueOnce(cleared ? [peer] : [line, peer]);
    vi.spyOn(control, "restoreReference").mockImplementation(
      async (previous, mask) => {
        const pixels = mask.toBitmap();
        expect(previous).toBe(first);
        expect(pixels[(18 * size.width + 14) * 4]).toBe(255);
        expect(pixels[(33 * size.width + 36) * 4]).toBe(0);
        return previous;
      },
    );
    vi.spyOn(control, "restoreMeasuredPrint")
      .mockResolvedValueOnce(first)
      .mockResolvedValue(result);
    const nativePaint = image(218);
    const paint = vi
      .spyOn(control.registration, "registerImage")
      .mockImplementation(
        async (script, input, mask, decoded, _signal, mode) => {
          expect(script).toBe("qwen-restore-illustration.py");
          expect(mode).toBe("--credit-paint");
          expect(input).toBe(join(dir, "original.png"));
          expect(mask).toBe(join(dir, "mask.png"));
          expect(decoded).toBe(result);
          return hint === "pigment:" ? nativePaint : undefined;
        },
      );
    try {
      const documented = await finishMeasuredPrint(
        {
          request: {
            illustratedTitle: hint,
            input: join(dir, "original.png"),
            mask: join(dir, "mask.png"),
            output: join(dir, "out.png"),
            steps: 40,
            strength: 1,
            maxPixels: 1024 * 1024,
            maskPadding: 0,
          },
          source,
          stencil,
          control,
          decoded: first.toBitmap(),
          signal: new AbortController().signal,
          sizeFor: () => size,
          sample: async (argumentsFor, output) => {
            const args = await argumentsFor(output);
            const request = JSON.parse(
              await readFile(args[args.length - 1], "utf8"),
            );
            expect(request.referenceSource).toBe(true);
            expect(request.prompt).toContain("文字");
            return result.toBitmap();
          },
        },
        referenceEditMode(hint).material,
      );
      expect(paint).toHaveBeenCalledTimes(Number(cleared));
      expect(documented).toBe(
        cleared ? (hint === "pigment:" ? nativePaint : result) : first,
      );
    } finally {
      await control.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("reuses the jacket verifier across crops and rejects an inconsistent output map", async () => {
  const weights = vi
    .spyOn(downloads, "ensureRemoteFile")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue("jacket.onnx");
  const verifier = new QwenJacketVerifier("models");
  const size = { width: 64, height: 32 };
  const image = nativeImage.createFromBitmap(
    Buffer.alloc(64 * 32 * 4, 255),
    size,
  );
  const signal = new AbortController().signal;
  const map = new Float32Array(32).fill(1);
  try {
    await expect(verifier.lines(image, signal)).rejects.toThrow("offline");
    runtime.run.mockResolvedValueOnce({
      restored: { data: map, dims: [1, 1, 4, 8], dispose: vi.fn() },
    });
    expect(await verifier.lines(image, signal)).toEqual([
      { x: 0, y: 0, w: 64, h: 32 },
    ]);
    runtime.run.mockResolvedValueOnce({
      restored: { data: map, dims: [1, 1, 4, 7], dispose: vi.fn() },
    });
    await expect(verifier.lines(image, signal)).rejects.toThrow("검증 맵");
    expect(weights).toHaveBeenCalledTimes(2);
  } finally {
    weights.mockRestore();
    await verifier.dispose();
  }
});
