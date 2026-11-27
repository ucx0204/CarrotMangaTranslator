import {
  runtime,
  makeControlCrop,
  controlLaunch,
} from "./qwenControlCrop.fixture";
import {
  QwenNativeReference,
  prepareQwenSamplingInputs,
} from "../src/main/inpainting/qwenNativeReference";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeImage } from "electron";
import { expect, it, vi } from "vitest";
import { QwenControlCrop } from "../src/main/inpainting/qwenControlCrop";
import {
  readFluxCropCandidates,
  readNativeCropInputs,
} from "../src/main/inpainting/fluxCropIO";
import { QwenSubstrate } from "../src/main/inpainting/qwenSubstrate";
import { QwenImageWorker } from "../src/main/inpainting/qwenImageWorker";
import { QwenGpuBudget } from "../src/main/inpainting/qwenGpuBudget";
import { hasWhiteTitleOnDarkStock } from "../src/main/inpainting/qwenPrintedReference";

it("uses the original as Qwen's title reference and supplies the erased substrate only for the native join", async () => {
  const root = await mkdtemp(join(tmpdir(), "qwen-washed-title-"));
  const size = { width: 96, height: 80 },
    count = size.width * size.height;
  const bytes = Buffer.alloc(4 * count, 245);
  const paper = nativeImage.createFromBitmap(bytes, size);
  bytes.fill(34, 800, 1196);
  const scan = nativeImage.createFromBitmap(bytes, size);
  const stencil = new Uint8Array(count);
  stencil.fill(1, 200, 299);
  const crop = makeControlCrop(),
    signal = new AbortController().signal;
  const input = join(root, "original.png"),
    mask = join(root, "mask.png");
  const restore = vi
    .spyOn(QwenSubstrate.prototype, "restore")
    .mockResolvedValue(paper);
  let evidence = "";
  try {
    const prepared = await crop.prepare(
      scan,
      stencil,
      input,
      signal,
      mask,
      "washed-title:章題",
    );
    expect(prepared.prior).toBe(scan);
    expect(prepared.material).toEqual({ kind: "washed-title", prior: paper });
    expect(await crop.restoreReference(scan, paper, signal)).toBe(paper);
    if (!prepared.material) throw Error("Missing measured substrate");
    runtime.screen.mockImplementationOnce(
      async (_exe: string, args: string[]) => {
        const mode = args[args.length - 1];
        expect(mode.startsWith("--washed-title=")).toBe(true);
        evidence = mode.slice("--washed-title=".length);
        expect(await readFile(evidence)).toEqual(paper.toPNG());
        await writeFile(args[args.length - 2], scan.toPNG());
        return { stdout: "applied" };
      },
    );
    const result = await crop.restoreMeasuredPrint(
      input,
      mask,
      bytes,
      size,
      signal,
      prepared.material,
    );
    expect(result.toBitmap()).toEqual(scan.toBitmap());
    await expect(readFile(evidence)).rejects.toMatchObject({ code: "ENOENT" });
    runtime.screen.mockImplementationOnce(
      async (_exe: string, args: string[]) => {
        expect(args).toContain(join(".", "qwen-reconnect-balloon.py"));
        expect(await readFile(args[args.length - 1])).toEqual(paper.toPNG());
        await writeFile(args[args.length - 2], scan.toPNG());
        return { stdout: "applied" };
      },
    );
    await crop.restoreMeasuredPrint(input, mask, bytes, size, signal, {
      kind: "dialogue",
      prior: paper,
    });
    const layered = await crop.prepare(
      scan,
      stencil,
      input,
      signal,
      mask,
      "layered-title:重版",
    );
    expect(layered.prior).toBe(scan);
    expect(layered.titleSource).toBe(paper);
    expect(layered.referenceEdit).toBe("layeredTitle");
    for (const material of [
      { kind: "crossed-rule", row: 18, radius: 3 } as const,
      { kind: "brush" } as const,
    ]) {
      runtime.screen.mockImplementationOnce(
        async (_exe: string, args: string[]) => {
          expect(args[args.length - 1]).toBe(
            material.kind === "brush" ? "--brush" : "--crossed-rule=18,3",
          );
          await writeFile(args[args.length - 2], scan.toPNG());
          return { stdout: "applied" };
        },
      );
      await crop.restoreMeasuredPrint(
        input,
        mask,
        bytes,
        size,
        signal,
        material,
      );
    }
  } finally {
    restore.mockRestore();
    await crop.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps verified native paper and removes a generated oval that never existed on the scan", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-paper-crop-"));
  const size = { width: 96, height: 96 },
    crop = { x: 0, y: 0, w: 96, h: 96 };
  const src = Buffer.alloc(4 * 96 * 96, 255),
    raw = Buffer.from(src);
  const core = {
    bounds: { x: 20, y: 20, w: 56, h: 56 },
    data: new Uint8Array(56 * 56).fill(1),
  };
  for (let i = 0; i < 96 * 96; i++) {
    const x = i % 96,
      y = Math.floor(i / 96),
      radius = Math.hypot(x - 48, y - 48);
    if (radius >= 18 && radius < 21) raw.fill(15, 4 * i, 4 * i + 3);
    if (
      (x >= 45 && x < 51 && y >= 41 && y < 55) ||
      (x === 35 && y >= 8 && y < 53)
    )
      src.fill(20, 4 * i, 4 * i + 3);
  }
  try {
    const file = join(dir, "model.png");
    await writeFile(file, nativeImage.createFromBitmap(raw, size).toPNG());
    const options = {
      source: src,
      crop,
      width: 96,
      height: 96,
      constraint: null,
      core,
    };
    const preserved = await readFluxCropCandidates(file, {
      ...options,
      nativePaper: true,
    });
    expect(preserved.generated).toBe(preserved.contextGenerated);
    expect(preserved.generated[4 * (48 * 96 + 68)]).toBe(15);
    const repaired = await readFluxCropCandidates(file, options);
    expect(repaired.generated[4 * (48 * 96 + 68)]).toBe(255);
    expect(repaired.generated[4 * (47 * 96 + 35)]).toBe(20);
    expect(repaired.contextGenerated[4 * (48 * 96 + 68)]).toBe(15);
    const registered = await readFluxCropCandidates(file, {
      ...options,
      registeredLettering: true,
    });
    expect(registered.generated).toEqual(registered.contextGenerated);
    expect(registered.generated[4 * (48 * 96 + 68)]).toBe(15);
    const mask = join(dir, "invalid-size.png");
    await writeFile(
      mask,
      nativeImage
        .createFromBitmap(Buffer.alloc(4 * 16 * 16, 255), {
          width: 16,
          height: 16,
        })
        .toPNG(),
    );
    await expect(readNativeCropInputs(file, mask)).rejects.toThrow("일치하지");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("carries a confirmed interrupted balloon prior into the reference edit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qwen-interrupted-dialogue-"));
  const size = { width: 68, height: 84 };
  const input = join(dir, "source.png"),
    mask = join(dir, "mask.png");
  const crop = makeControlCrop(),
    signal = new AbortController().signal;
  const bytes = Buffer.alloc(4 * size.width * size.height, 255);
  const source = nativeImage.createFromBitmap(bytes, size);
  bytes.fill(37, 6600, 6603);
  const prior = nativeImage.createFromBitmap(bytes, size);
  const stencil = new Uint8Array(size.width * size.height);
  stencil.fill(1, 500, 550);
  try {
    runtime.screen.mockResolvedValueOnce({ stdout: "unchanged" });
    expect(
      await crop.interruptedDialogue(input, mask, prior, signal),
    ).toBeUndefined();
    runtime.screen.mockImplementationOnce(
      async (_exe: string, args: string[]) => {
        expect(args).toContain(join(".", "qwen-reconnect-balloon.py"));
        const [inputPath, outputPath] = args.slice(-2);
        expect(await readFile(inputPath)).toEqual(prior.toPNG());
        await writeFile(outputPath, prior.toPNG());
        return { stdout: "applied" };
      },
    );
    const confirmed = await crop.interruptedDialogue(
      input,
      mask,
      prior,
      signal,
    );
    expect(confirmed?.prior).toBe(prior);
    const prepared = await crop.prepare(
      source,
      stencil,
      input,
      signal,
      mask,
      confirmed,
    );
    expect(prepared.referenceEdit).toBe("dialogue");
    expect(prepared.material).toBe(confirmed);
    expect(prepared.prior).toBe(source);
    for (const mode of ["caption", "masthead"] as const) {
      const reference = await crop.prepare(
        source,
        stencil,
        input,
        signal,
        mask,
        mode,
      );
      expect(reference.material?.kind).toBe(mode);
      expect(reference.referenceEdit).toBe(mode);
    }
  } finally {
    runtime.screen.mockReset();
    await crop.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it("uses only valid native contour scores when comparing two cover edits", async () => {
  const crop = makeControlCrop();
  const signal = new AbortController().signal;
  try {
    for (const score of ["", "nan", "1.001", "-2"]) {
      runtime.screen.mockResolvedValueOnce({ stdout: score });
      await expect(
        crop.registration.exposedContourError("source", "mask", "edit", signal),
      ).rejects.toThrow("윤곽");
    }
    runtime.screen.mockResolvedValueOnce({ stdout: " 0.275\n" });
    expect(
      await crop.registration.exposedContourError(
        "source",
        "mask",
        "edit",
        signal,
      ),
    ).toBe(0.275);
    expect(runtime.screen.mock.lastCall?.[1]).toContain("--edge-score");
  } finally {
    runtime.screen.mockReset();
  }
});

it("uses the measured print window only for a bounded, independently identified title", async () => {
  const crop = makeControlCrop();
  const registration = crop.registration;
  const signal = new AbortController().signal;
  const size = { width: 500, height: 240 };
  const args = ["source", "mask", size, signal] as const;
  try {
    expect(
      await registration.printedTitleReference("upright-jacket", ...args),
    ).toEqual({
      pairedWindow: { x: 0, y: 0, w: 500, h: 240, guide: "source" },
    });
    for (const hint of ["layered-title:", "caption", true])
      expect(
        await registration.printedTitleReference(hint, ...args),
      ).toBeUndefined();
    for (const dims of [
      { ...size, height: 168 },
      { ...size, width: 449 },
    ])
      expect(
        await registration.printedTitleReference(
          "layered-title:本",
          "source",
          "mask",
          dims,
          signal,
        ),
      ).toBeUndefined();
    expect(
      await registration.printedTitleReference(
        "layered-title:本",
        "source",
        undefined,
        size,
        signal,
      ),
    ).toBeUndefined();
    runtime.screen.mockResolvedValueOnce({ stdout: "unchanged" });
    expect(
      await registration.printedTitleReference("layered-title:本", ...args),
    ).toBeUndefined();
    const view = { x: 20, y: 18, w: 380, h: 174 };
    for (const bad of [
      { x: -0.5 },
      { x: -1 },
      { y: -1 },
      { w: 0 },
      { h: 0 },
      { w: 499 },
      { h: 239 },
    ]) {
      runtime.screen.mockResolvedValueOnce({
        stdout: JSON.stringify({ ...view, ...bad }),
      });
      await expect(
        registration.printedTitleReference("layered-title:本", ...args),
      ).rejects.toThrow("범위");
    }
    runtime.screen.mockResolvedValueOnce({ stdout: JSON.stringify(view) });
    expect(
      await registration.printedTitleReference("layered-title:本", ...args),
    ).toMatchObject({
      pairedWindow: { ...view, guide: "source.display-guide.png" },
    });
  } finally {
    runtime.screen.mockReset();
    await crop.dispose();
  }
});

it("checks whether the jacket can use native coordinates before composing a crop", async () => {
  const crop = makeControlCrop();
  const args = [
    "source",
    "mask",
    "scratch",
    new AbortController().signal,
  ] as const;
  try {
    runtime.screen.mockResolvedValueOnce({ stdout: "unchanged" });
    expect(await crop.registration.processJacketPlane("prepare", ...args)).toBe(
      false,
    );
    runtime.screen.mockResolvedValueOnce({ stdout: "applied" });
    expect(await crop.registration.processJacketPlane("compose", ...args)).toBe(
      true,
    );
    expect(runtime.screen.mock.lastCall?.[1]).toContain("compose");
    for (const status of ["unchanged", ""]) {
      runtime.screen.mockResolvedValueOnce({ stdout: status });
      await expect(
        crop.registration.processJacketPlane("compose", ...args),
      ).rejects.toThrow("좌표");
    }
  } finally {
    runtime.screen.mockReset();
    await crop.dispose();
  }
});

it("publishes the registered peer only when its original-scale contour evidence agrees", async () => {
  const root = await mkdtemp(join(tmpdir(), "qwen-cover-peer-"));
  const size = { width: 48, height: 36 },
    signal = new AbortController().signal;
  const target = join(root, "preferred.png"),
    peer = join(root, "peer.png");
  const pixels = Buffer.alloc(4 * size.width * size.height, 255);
  pixels.fill(67, 400, 403);
  const bytes = nativeImage.createFromBitmap(pixels, size).toPNG();
  const crop = makeControlCrop();
  try {
    runtime.screen.mockResolvedValueOnce({ stdout: "unchanged" });
    expect(
      await crop.reconcileCoverViews(
        "scan",
        "mask",
        target,
        peer,
        size,
        signal,
      ),
    ).toBeUndefined();
    runtime.screen.mockImplementationOnce(
      async (_exe: string, args: string[]) => {
        expect(args.at(-1)).toBe("--cover-peer=" + peer);
        await writeFile(args[8], bytes);
        return { stdout: "applied" };
      },
    );
    expect(
      await crop.reconcileCoverViews(
        "scan",
        "mask",
        target,
        peer,
        size,
        signal,
      ),
    ).toEqual(pixels);
  } finally {
    runtime.screen.mockReset();
    await rm(root, { recursive: true, force: true });
  }
});

it("edits the original illustrated cover from an empty latent and retains the native print stencil", async () => {
  const root = await mkdtemp(join(tmpdir(), "qwen-illustration-guide-"));
  const size = { width: 100, height: 110 };
  const source = nativeImage.createFromBitmap(
    Buffer.alloc(4 * 11000, 255),
    size,
  );
  const prior = nativeImage.createFromBitmap(
    Buffer.alloc(4 * 11000, 162),
    size,
  );
  const stencil = new Uint8Array(11000);
  for (const [x, y] of [
    [20, 10],
    [70, 20],
    [55, 92],
    [17, 82],
  ])
    stencil[y * 100 + x] = 1;
  const original = stencil.slice();
  const crop = makeControlCrop();
  const restore = vi
    .spyOn(QwenSubstrate.prototype, "restore")
    .mockResolvedValue(prior);
  try {
    const prepared = await crop.prepare(
      source,
      stencil,
      join(root, "input"),
      new AbortController().signal,
      undefined,
      true,
    );
    expect(prepared.condition[51 * 100 + 41]).toBe(0);
    expect(prepared.condition[95 * 100 + 89]).toBe(0);
    expect(stencil).toEqual(original);
    const args = await crop.argumentsFor(
      prepared,
      size,
      "printed.png",
      "output.png",
    );
    const request = JSON.parse(await readFile(args[args.length - 1], "utf8"));
    expect(request).toMatchObject({
      image: "printed.png",
      referencePrior: false,
      referenceSource: true,
      referenceEdit: true,
      cfg: 1,
      denoise: 1,
      steps: 40,
    });
    expect(restore).not.toHaveBeenCalled();
    expect(prepared.material?.kind).toBe("illustration");
  } finally {
    restore.mockRestore();
    await crop.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("conditions on the original drawing independently of the latent prior for joined outlined columns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qwen-outline-reference-"));
  const size = { width: 230, height: 285 };
  const rgb = Buffer.alloc(size.width * size.height * 4, 4);
  const stencil = new Uint8Array(size.width * size.height);
  for (let i = 0; i < stencil.length; i++) {
    const y = Math.floor(i / size.width);
    const x = i % size.width;
    rgb[4 * i + 3] = 255;
    const offset = x >= 112 ? x - 112 : x - 43;
    if (offset < 0 || offset >= 30 || y < 50 || y >= 217) continue;
    const counter = offset >= 6 && offset < 24 && y >= 58 && (y - 58) % 22 < 10;
    rgb.fill(counter ? 4 : 252, 4 * i, 4 * i + 3);
    stencil[i] = 1;
  }
  const image = nativeImage.createFromBitmap(rgb, size);
  const restore = vi
    .spyOn(QwenSubstrate.prototype, "restore")
    .mockResolvedValue(image);
  try {
    const crop = makeControlCrop();
    const input = join(dir, "original.png");
    const prepared = await crop.prepare(
      image,
      stencil,
      input,
      new AbortController().signal,
    );
    const args = await crop.argumentsFor(
      prepared,
      size,
      input,
      join(dir, "out.png"),
    );
    const config = JSON.parse(await readFile(args[args.length - 1], "utf8"));
    expect(config).toMatchObject({
      referenceSource: true,
      referencePrior: false,
      image: input,
      steps: 32,
      cfg: 1,
      denoise: 0.71,
    });
    expect(config.prior).not.toBe(config.image);
    expect(config.prompt).toContain("<image1>");
  } finally {
    restore.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

it("uses a controlled prior for independently outlined white columns on neutral dark paper", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qwen-neutral-title-"));
  const size = { width: 250, height: 300 };
  const pixels = Buffer.alloc(4 * size.width * size.height, 255);
  const stencil = new Uint8Array(size.width * size.height);
  for (let i = 0; i < stencil.length; i++) {
    const x = i % size.width,
      y = Math.floor(i / size.width);
    const u = x >= 127 ? x - 127 : x - 52;
    const column = u >= 0 && u < 36 && y >= 32 && y < 258;
    const ink = u >= 6 && u < 30 && (y - 32) % 23 >= 5 && (y - 32) % 23 < 17;
    pixels.fill(column && !ink ? 252 : 9, 4 * i, 4 * i + 3);
    stencil[i] = Number(column);
  }
  const image = nativeImage.createFromBitmap(pixels, size);
  const restore = vi
    .spyOn(QwenSubstrate.prototype, "restore")
    .mockResolvedValue(image);
  const crop = makeControlCrop();
  try {
    expect(hasWhiteTitleOnDarkStock(image, stencil)).toBe(true);
    const prepared = await crop.prepare(
      image,
      stencil,
      join(dir, "page.png"),
      new AbortController().signal,
      undefined,
      true,
    );
    expect(prepared.material?.kind).toBe("lettering");
    expect(prepared.referenceEdit).toBeUndefined();
    expect(restore).toHaveBeenCalledOnce();
    for (let i = 0; i < stencil.length; i++)
      if (!stencil[i]) pixels[4 * i] = 140;
    expect(
      hasWhiteTitleOnDarkStock(
        nativeImage.createFromBitmap(pixels, size),
        stencil,
      ),
    ).toBe(false);
  } finally {
    restore.mockRestore();
    await crop.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it("uses registered native-size silhouettes and rejects a mismatched decoder grid", async () => {
  const root = await mkdtemp(join(tmpdir(), "qwen-register-"));
  const crop = new QwenControlCrop(controlLaunch());
  const size = { width: 11, height: 14 };
  const original = Buffer.alloc(size.width * size.height * 4, 255);
  const changed = Buffer.from(original);
  changed.fill(72, 24, 27);
  const signal = new AbortController().signal;
  const execute = () =>
    crop.registerDecodedContours(
      join(root, "source.png"),
      join(root, "mask.png"),
      original,
      size,
      signal,
    );
  try {
    for (const outputSize of [size, { width: 10, height: 15 }]) {
      runtime.screen.mockImplementationOnce(
        async (_exe: string, args: string[]) => {
          expect(
            args.some((path) => path.endsWith("qwen-register-contours.py")),
          ).toBe(true);
          const bytes =
            outputSize === size ? changed : Buffer.alloc(10 * 15 * 4, 255);
          await writeFile(
            args[args.length - 1],
            nativeImage.createFromBitmap(bytes, outputSize).toPNG(),
          );
          return { stdout: "applied" };
        },
      );
      if (outputSize === size) expect(await execute()).toEqual(changed);
      else await expect(execute()).rejects.toThrow("크기");
    }
  } finally {
    await crop.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("publishes only the complete native result when screen recovery fails and the crop is retried", async () => {
  const root = await mkdtemp(join(tmpdir(), "qwen-complete-output-"));
  const control = controlLaunch();
  const worker = new QwenImageWorker({
    executable: process.execPath,
    env: {},
    gpuUuid: "cpu-test",
    models: control.models,
    control,
  });
  const options = { width: 64, height: 64 };
  const bitmap = Buffer.alloc(64 * 64 * 4, 255);
  // Neither the source nor the known output is uniform paper.
  for (let i = 0; i < 64 * 64; i++)
    bitmap.fill(40 + (i % 93), 4 * i, 4 * i + 3);
  const image = nativeImage.createFromBitmap(bitmap, options);
  const request = {
    input: join(root, "input.png"),
    mask: join(root, "mask.png"),
    output: join(root, "output.png"),
    steps: 36,
    strength: 1,
    maskPadding: 0,
    maxPixels: 4096,
  };
  const peers = vi
    .spyOn(QwenGpuBudget.prototype, "wait")
    .mockResolvedValue(undefined);
  const board = vi
    .spyOn(QwenGpuBudget.prototype, "monitor")
    .mockResolvedValue("ready");
  const prepare = vi
    .spyOn(QwenControlCrop.prototype, "prepare")
    .mockResolvedValue({
      size: options,
      condition: new Uint8Array(4096),
      prior: image,
      prefix: request.input,
      registered: true,
      sourceReference: false,
      titleSource: undefined,
      material: undefined,
    });
  const sample = vi
    .spyOn(QwenControlCrop.prototype, "argumentsFor")
    .mockImplementation(async (_crop, _size, input, output) => {
      const config = join(root, "reference.json");
      await writeFile(config, JSON.stringify({ input, output }));
      return [
        "-e",
        `const fs = require("node:fs");
         require("node:readline").createInterface({input: process.stdin}).on("line", line => {
           const request = JSON.parse(line);
           if (request.type === "shutdown") return process.exit(0);
           const {input, output} = JSON.parse(fs.readFileSync(request.config));
           fs.copyFileSync(input, output);
           console.log(JSON.stringify({id: request.id, ok: true}));
         });`,
        "--",
        config,
      ];
    });
  try {
    await writeFile(request.input, image.toPNG());
    const mask = Buffer.alloc(bitmap.length, 0);
    for (let i = 0; i < 4096; i++) {
      mask[i * 4 + 3] = 255;
      if (i % 64 > 25 && i % 64 < 39 && i / 64 > 26 && i / 64 < 39)
        mask.fill(255, i * 4, i * 4 + 3);
    }
    await writeFile(
      request.mask,
      nativeImage.createFromBitmap(mask, options).toPNG(),
    );
    await writeFile(request.output, "last complete crop");
    runtime.screen
      .mockResolvedValueOnce({ stdout: "unchanged" })
      .mockRejectedValueOnce(new Error("screen read failed"));
    await expect(worker.inpaint(request)).rejects.toThrow("screen read failed");
    expect(await readFile(request.output, "utf8")).toBe("last complete crop");
    runtime.screen
      .mockResolvedValueOnce({ stdout: "unchanged" })
      .mockResolvedValueOnce({ stdout: "unchanged" });
    await worker.inpaint(request, new AbortController().signal);
    const committed = nativeImage.createFromBuffer(
      await readFile(request.output),
    );
    expect(committed.getSize()).toEqual({ width: 64, height: 64 });
    expect(committed.toBitmap()).toEqual(bitmap);
    expect(peers).toHaveBeenCalledTimes(1);
    expect(board).toHaveBeenCalledTimes(1);
    // A native detail pass may introduce small RGB errors even after decoding.
    const speck = Buffer.from(bitmap);
    speck.set([179, 188, 198], 404);
    const tinted = nativeImage.createFromBitmap(speck, options);
    for (const coloredSource of [false, true]) {
      if (coloredSource) await writeFile(request.input, tinted.toPNG());
      runtime.screen
        .mockResolvedValueOnce({ stdout: "unchanged" })
        .mockImplementationOnce(async (_exe: string, args: string[]) => {
          await writeFile(args[args.length - 1], tinted.toPNG());
          return { stdout: "applied" };
        });
      await worker.inpaint(request);
      const actual = nativeImage
        .createFromBuffer(await readFile(request.output))
        .toBitmap();
      expect([...actual.subarray(404, 408)]).toEqual(
        coloredSource ? [179, 188, 198, 255] : [190, 190, 190, 255],
      );
    }
  } finally {
    await worker.dispose();
    peers.mockRestore();
    board.mockRestore();
    prepare.mockRestore();
    sample.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it("publishes a verified native screentone pass and preserves the crop on an inconclusive result", async () => {
  const root = await mkdtemp(join(tmpdir(), "qwen-native-screen-"));
  const crop = makeControlCrop(),
    output = join(root, "result.png");
  const signal = new AbortController().signal;
  try {
    await writeFile(output, "original");
    runtime.screen.mockResolvedValueOnce({ stdout: "unchanged" });
    await crop.restorePrintedScreen("scan.png", "ink.png", output, signal);
    expect(await readFile(output, "utf8")).toBe("original");
    runtime.screen.mockResolvedValueOnce({ stdout: "unverified" });
    await expect(
      crop.restorePrintedScreen("scan.png", "ink.png", output, signal),
    ).rejects.toThrow("망점");
    expect(await readFile(output, "utf8")).toBe("original");
    runtime.screen.mockImplementationOnce(
      async (_exe: string, args: string[]) => {
        expect(args.slice(-4, -1)).toEqual(["scan.png", "ink.png", output]);
        await writeFile(args[args.length - 1], "restored");
        return { stdout: "applied" };
      },
    );
    await crop.restorePrintedScreen("scan.png", "ink.png", output, signal);
    expect(await readFile(output, "utf8")).toBe("restored");
    runtime.screen.mockImplementationOnce(
      async (_exe: string, args: string[]) => {
        expect(args.at(-1)).toBe("--framed-only");
        return { stdout: "unchanged" };
      },
    );
    await crop.restorePrintedScreen(
      "scan.png",
      "ink.png",
      output,
      signal,
      true,
    );
    runtime.screen.mockImplementationOnce(
      async (_exe: string, args: string[]) => {
        expect(args.at(-1)).toBe("--speech");
        return { stdout: "unchanged" };
      },
    );
    await crop.restorePrintedScreen(
      "scan.png",
      "ink.png",
      output,
      signal,
      false,
      true,
    );
  } finally {
    await crop.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("uses a registered substrate only when the original mask and native contrast support it", async () => {
  const root = await mkdtemp(join(tmpdir(), "qwen-native-material-"));
  const crop = makeControlCrop();
  const size = { width: 192, height: 120 };
  const stencil = new Uint8Array(size.width * size.height);
  const pixels = Buffer.alloc(4 * stencil.length, 255);
  for (let i = 0; i < stencil.length; i++) {
    const x = i % size.width;
    if (x < 26 || x > 159) continue;
    stencil[i] = 1;
    if (x % 4 < 2) pixels.fill(21, i * 4, i * 4 + 3);
  }
  const source = nativeImage.createFromBitmap(pixels, size);
  const prepare = vi
    .spyOn(QwenSubstrate.prototype, "restore")
    .mockResolvedValue(source);
  const signal = new AbortController().signal;
  const input = join(root, "input.png");
  const mask = join(root, "print.png");
  try {
    const unchanged = await crop.prepare(source, stencil, input, signal);
    expect(unchanged.registered).toBe(false);
    runtime.screen.mockResolvedValueOnce({ stdout: "unchanged" });
    const directFallback = await crop.prepare(
      source,
      stencil,
      input,
      signal,
      mask,
      true,
    );
    expect(directFallback.referenceEdit).toBe("cover");
    expect(directFallback.prior).toBe(source);
    for (const result of ["unchanged", "applied"]) {
      runtime.screen.mockImplementationOnce(
        async (_exe: string, args: string[]) => {
          expect(args.slice(-5, -2)).toEqual([
            join(".", "qwen-register-substrate.py"),
            input,
            mask,
          ]);
          if (result === "applied")
            await writeFile(args[args.length - 1], source.toPNG());
          return { stdout: result };
        },
      );
      const got = await crop.prepare(
        source,
        stencil,
        input,
        signal,
        mask,
        result === "applied",
      );
      const command = await crop.argumentsFor(
        got,
        size,
        input,
        join(root, "output.png"),
      );
      const args = JSON.parse(
        await readFile(command[command.length - 1], "utf8"),
      );
      expect(got.registered).toBe(result === "applied");
      expect(args.referencePrior).toBe(result === "applied");
      expect(args.denoise).toBe(result === "applied" ? 0.49 : 0.54);
      if (got.material?.kind === "sky") {
        let witness = "";
        runtime.screen.mockImplementationOnce(
          async (_exe: string, command: string[]) => {
            witness = command[command.length - 1];
            expect(await readFile(witness)).toEqual(source.toPNG());
            await writeFile(command[command.length - 2], source.toPNG());
            return { stdout: "applied" };
          },
        );
        const native = await crop.restoreMeasuredPrint(
          input,
          mask,
          pixels,
          size,
          signal,
          got.material,
        );
        expect(native.toBitmap()).toEqual(source.toBitmap());
        await expect(readFile(witness)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    }
  } finally {
    prepare.mockRestore();
    await crop.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("uses the measured printing range for both the Qwen reference and its native output", async () => {
  const root = await mkdtemp(join(tmpdir(), "qwen-title-stock-"));
  const crop = makeControlCrop();
  const size = { width: 320, height: 158 };
  const pixels = Buffer.alloc(size.width * size.height * 4, 255);
  const stencil = new Uint8Array(size.width * size.height);
  for (let i = 0; i < stencil.length; i++) {
    const x = i % size.width,
      y = Math.floor(i / size.width);
    const ink =
      x > 22 &&
      x < 294 &&
      ((y > 31 && y < 63) || (y > 84 && y < 122)) &&
      x % 21 < 5;
    stencil[i] = Number(ink);
    if (ink || [17, 73, 138].includes(y)) pixels.fill(15, 4 * i, 4 * i + 3);
  }
  const source = nativeImage.createFromBitmap(pixels, size);
  const restore = vi
    .spyOn(QwenSubstrate.prototype, "restore")
    .mockResolvedValue(source);
  const signal = new AbortController().signal,
    input = join(root, "input.png"),
    mask = join(root, "mask.png");
  const modes: string[] = [];
  try {
    await writeFile(mask, source.toPNG());
    runtime.screen.mockImplementation(async (_exe: string, args: string[]) => {
      expect(args).toContain(join(".", "qwen-title-stock.py"));
      modes.push(args[args.length - 1]);
      await writeFile(args[args.length - 2], source.toPNG());
      return { stdout: "applied" };
    });
    const got = await crop.prepare(source, stencil, input, signal, mask);
    expect(got.titleSource?.getSize()).toEqual({ width: 320, height: 158 });
    const cmd = await crop.argumentsFor(
      got,
      size,
      input,
      join(root, "decoded.png"),
    );
    expect(
      JSON.parse(await readFile(cmd[cmd.length - 1], "utf8")),
    ).toMatchObject({
      denoise: 0.45,
      referencePrior: true,
    });
    expect(
      (
        await crop.restoreMeasuredPrint(input, mask, pixels, size, signal, {
          kind: "title",
        })
      ).getSize(),
    ).toEqual({ width: 320, height: 158 });
    expect(modes).toEqual(["source", "guide", "finish"]);
    runtime.screen.mockResolvedValueOnce({ stdout: "unchanged" });
    const unregistered = await crop.prepare(
      source,
      stencil,
      input,
      signal,
      mask,
    );
    expect(unregistered.titleSource).toBeUndefined();
    runtime.screen
      .mockImplementationOnce(async (_exe: string, args: string[]) => {
        await writeFile(args[args.length - 2], source.toPNG());
        return { stdout: "applied" };
      })
      .mockResolvedValueOnce({ stdout: "unchanged" });
    const fallback = await crop.prepare(
      source,
      stencil,
      input,
      signal,
      mask,
      "lettering",
    );
    expect(fallback.prior).toBe(source);
    expect(fallback.material).toEqual({ kind: "title" });
    runtime.screen.mockResolvedValueOnce({ stdout: "unchanged" });
    await expect(
      crop.restoreMeasuredPrint(input, mask, pixels, size, signal, {
        kind: "title",
      }),
    ).rejects.toThrow("농도");
  } finally {
    runtime.screen.mockReset();
    restore.mockRestore();
    await crop.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  { width: 96, height: 80 },
  { width: 960, height: 992 },
])(
  "uses the plain control prior outside the native measurement sizes ($width × $height)",
  async (size) => {
    const root = await mkdtemp(join(tmpdir(), "qwen-unmeasured-size-"));
    const crop = makeControlCrop();
    const count = size.width * size.height;
    const image = nativeImage.createFromBitmap(
      Buffer.alloc(count * 4, 255),
      size,
    );
    const stencil = new Uint8Array(count);
    stencil.fill(1, size.width, size.width + 27);
    const restore = vi
      .spyOn(QwenSubstrate.prototype, "restore")
      .mockResolvedValue(image);
    const calls = runtime.screen.mock.calls.length;
    try {
      const prepared = await crop.prepare(
        image,
        stencil,
        join(root, "source.png"),
        new AbortController().signal,
        join(root, "mask.png"),
      );
      expect(prepared.material).toBeUndefined();
      expect(prepared.prior).toBe(image);
      expect(runtime.screen.mock.calls).toHaveLength(calls);
    } finally {
      restore.mockRestore();
      await crop.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("keeps native pixels outside the condition and registers image, mask and prior at the same sampler size", async () => {
  const root = await mkdtemp(join(tmpdir(), "qwen-control-crop-"));
  const crop = makeControlCrop();
  const size = { width: 48, height: 24 };
  const source = Buffer.alloc(size.width * size.height * 4, 255);
  const stencil = new Uint8Array(size.width * size.height);
  for (let y = 9; y < 16; y++)
    stencil.fill(1, y * size.width, y * size.width + 7);
  const image = nativeImage.createFromBitmap(source, size);
  const signal = new AbortController().signal;
  const prefix = join(root, "crop");
  try {
    const area = 512 * 512;
    const planar = new Float32Array(area * 3);
    planar.fill(0.8, 0, area);
    planar.fill(0.4, area, 2 * area);
    planar.fill(0.2, 2 * area);
    runtime.run.mockResolvedValue({
      restored: {
        data: planar,
        dims: [1, 3, 512, 512],
        dispose: runtime.disposeTensor,
      },
    });
    const prepared = await crop.prepare(image, stencil, prefix, signal);
    const restored = prepared.prior.toBitmap();
    expect(prepared.condition[12 * size.width]).toBe(1);
    expect(prepared.condition[0]).toBe(0);
    for (let i = 0; i < stencil.length; i++) {
      const color = restored.subarray(4 * i, 4 * i + 4);
      if (prepared.condition[i])
        expect([...color]).toEqual([51, 102, 204, 255]);
      else expect(color).toEqual(source.subarray(4 * i, 4 * i + 4));
    }
    expect(runtime.disposeTensor).toHaveBeenCalledTimes(3);
    const target = { width: 96, height: 64 };
    const args = await crop.argumentsFor(
      prepared,
      target,
      "source.png",
      "output.png",
    );
    const config = JSON.parse(await readFile(args[args.length - 1], "utf8"));
    expect(config).toMatchObject({
      image: "source.png",
      output: "output.png",
      diffusion: "Q8",
      control: "union",
      seed: 417,
    });
    for (const file of [config.mask, config.prior]) {
      expect(
        nativeImage.createFromBuffer(await readFile(file)).getSize(),
      ).toEqual(target);
    }
    const invalid = {
      data: planar,
      dims: [3, 512, 512],
      dispose: runtime.disposeTensor,
    };
    runtime.run.mockResolvedValue({ restored: invalid });
    await expect(crop.prepare(image, stencil, prefix, signal)).rejects.toThrow(
      "출력 크기",
    );
    expect(runtime.disposeTensor).toHaveBeenCalledTimes(6);
    await expect(
      crop.prepare(image, new Uint8Array(stencil.length), prefix, signal),
    ).rejects.toThrow("비어");
  } finally {
    await crop.dispose();
    await rm(root, { recursive: true, force: true });
  }
  expect(runtime.stopProcess).toHaveBeenCalledTimes(1);
});

it("feeds sd.cpp a cleared native reference, aligned mask and the physical GPU selected by the app", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qwen-native-inputs-"));
  const size = { width: 64, height: 96 };
  const stencil = new Uint8Array(size.width * size.height);
  const bitmap = Buffer.alloc(stencil.length * 4, 255);
  for (let y = 30; y < 60; y++)
    for (let x = 23; x < 34; x++) {
      stencil[y * size.width + x] = 1;
      bitmap.fill(5, 4 * (y * size.width + x), 4 * (y * size.width + x) + 3);
    }
  const inputs = {
      source: nativeImage.createFromBitmap(bitmap, size),
      stencil,
    },
    signal = new AbortController().signal;
  const request = {
    input: join(directory, "input.png"),
    mask: join(directory, "mask.png"),
    output: join(directory, "result.png"),
    maxPixels: 6144,
    strength: 1,
    steps: 40,
    maskPadding: 0,
  };
  const models = { ...controlLaunch().models, vision: "projector" };
  const native = new QwenNativeReference(
    models,
    { directory: "loras", name: "print", strength: 0.65 },
    "Vulkan1",
  );
  runtime.run.mockResolvedValue({
    restored: {
      data: new Float32Array(512 * 512 * 3).fill(1),
      dims: [1, 3, 512, 512],
      dispose: runtime.disposeTensor,
    },
  });
  try {
    const execute = await prepareQwenSamplingInputs(
      { native },
      request,
      inputs,
      undefined,
      size,
      signal,
    );
    const args = await execute(request.output);
    const settings = JSON.parse(await readFile(args[0], "utf8"));
    expect(settings.context.backend).toBe(
      "clip=Vulkan1,vae=Vulkan1,diffusion=Vulkan1",
    );
    expect(native.offloadEncodersAfterPressure()).toBe(true);
    const [retry] = await execute(request.output);
    expect(JSON.parse(await readFile(retry, "utf8")).context.backend).toBe(
      "clip=cpu,vae=cpu,diffusion=Vulkan1",
    );
    expect(native.offloadEncodersAfterPressure()).toBe(false);
    expect(settings.context.llm_vision_path).toBe("projector");
    expect(settings.lora).toEqual({
      path: join("loras", "print.safetensors"),
      multiplier: 0.65,
      is_high_noise: false,
    });
    expect(settings.references).toEqual([
      request.input + ".qwen.png",
      request.mask + ".qwen.png",
    ]);
    expect(settings.output).toBe(request.output);
    const resolved = nativeImage.createFromBuffer(
      await readFile(request.input + ".qwen.png"),
    );
    const ink = nativeImage.createFromBuffer(
      await readFile(request.mask + ".qwen.png"),
    );
    expect(resolved.getSize()).toEqual({ width: 64, height: 96 });
    expect(ink.getSize()).toEqual({ width: 64, height: 96 });
    expect(resolved.toBitmap()[4 * (44 * 64 + 27)]).toBe(255);
    expect(ink.toBitmap()[4 * (44 * 64 + 27)]).toBe(255);
    expect(ink.toBitmap()[0]).toBe(0);
    await expect(
      prepareQwenSamplingInputs({}, request, inputs, undefined, size, signal),
    ).rejects.toThrow(/설정/);
  } finally {
    await native.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
