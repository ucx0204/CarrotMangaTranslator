import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveContextTiles,
  resolveFluxProcessSize,
} from "../src/main/inpainting/maskGeometry";
import { FLUX_INPAINT_CONTEXT_PX } from "../src/main/inpainting/fluxEngineConstants";

const tempDirs: string[] = [];

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("Flux inpainting engine change detection", () => {
  it("leaves a selected window alone when all its model ink belongs to another crop", async () => {
    const { prepareFluxWindowCrops } =
      await import("../src/main/inpainting/fluxCropTiling");
    const width = 64,
      height = 64;
    const mask = new Uint8Array(width * height);
    mask[20 * width + 30] = 1;
    const options = {
      width,
      height,
      mask,
      window: { x: 15, y: 13, w: 38, h: 34 },
      contextPx: 12,
      featherPx: 0,
      maskPaddingPx: 0,
      maxPixels: 1024 * 1024,
      cropStrategy: "worker-resize" as const,
      isolatedReference: true,
    };
    expect(
      prepareFluxWindowCrops({
        ...options,
        inputMask: new Uint8Array(mask.length),
      }),
    ).toEqual([]);
    const [tile] = prepareFluxWindowCrops(options);
    expect(tile.paddedBounds).toEqual(options.window);
    expect(tile.localMask.some(Boolean)).toBe(true);
  });
  it("restores framed paper without feeding the correction into the next worker input", async () => {
    vi.doMock("electron", () => ({ nativeImage: createFakeNativeImage() }));
    const { createFluxEngine } =
      await import("../src/main/inpainting/fluxEngine");
    const root = createTempDir("mgt-flux-framed-bubble-");
    const capture = join(root, "requests.json");
    const worker = join(root, "worker.cjs");
    writeFileSync(worker, createMaskCaptureWorkerScript(capture));
    const engine = createFluxEngine({
      diagnostics: createTestDiagnostics(),
      launch: {
        backend: "cuda-native",
        executable: process.execPath,
        args: [worker],
        runtimePath: root,
        label: "test Flux worker",
      },
      runRootDir: root,
    });
    const bitmap = Buffer.alloc(64 * 64 * 4, 255);
    for (let y = 19; y <= 40; y++)
      for (const x of [19, 40])
        bitmap.fill(0, (y * 64 + x) * 4, (y * 64 + x) * 4 + 3);
    for (let y = 27; y < 33; y++)
      for (let x = 27; x < 33; x++)
        bitmap.fill(0, (y * 64 + x) * 4, (y * 64 + x) * 4 + 3);
    const constraint = {
      bounds: { x: 20, y: 20, w: 20, h: 20 },
      data: new Uint8Array(400).fill(1),
    };
    const core = {
      bounds: { x: 27, y: 27, w: 6, h: 6 },
      data: new Uint8Array(36).fill(1),
    };
    const following = {
      bounds: { x: 44, y: 24, w: 10, h: 10 },
      data: new Uint8Array(100).fill(1),
    };
    const before = Buffer.from(bitmap);
    try {
      await engine.inpaint(
        bitmap,
        64,
        64,
        new Uint8Array(4096).fill(1),
        [constraint.bounds, following.bounds],
        {
          contextPx: 64,
          maskPaddingPx: 0,
          featherPx: 3,
          speechBubbleWindows: [true, false],
          windowMasks: [constraint, following],
          compositeConstraints: [constraint, following],
          compositeMasks: [core, following],
          requirePixelChange: true,
        },
      );
    } finally {
      await engine.dispose();
    }
    expect(bitmap[(30 * 64 + 30) * 4]).toBe(255);
    for (let i = 0; i < 4096; i++) {
      if (i % 64 >= 20 && i % 64 < 40 && i >= 20 * 64 && i < 40 * 64) continue;
      expect(bitmap.subarray(i * 4, i * 4 + 4)).toEqual(
        before.subarray(i * 4, i * 4 + 4),
      );
    }
    const requests = JSON.parse(readFileSync(capture, "utf8"));
    expect(requests).toEqual([
      expect.objectContaining({ speechBubble: true }),
      expect.objectContaining({ speechBubble: false }),
    ]);
    expect(requests[1].inputHash).toBe(requests[0].inputHash);
  });

  it("erases native ink under the wider composite shoulder of an earlier Qwen crop", async () => {
    const images = createFakeNativeImage();
    vi.doMock("electron", () => ({ nativeImage: images }));
    const { runFluxInpaint } =
      await import("../src/main/inpainting/fluxEngineRunner");
    const width = 64,
      height = 64,
      bitmap = createCoordinateBitmap(width, height);
    const square = (x: number, w: number) => ({
      bounds: { x, y: 22, w, h: 12 },
      data: new Uint8Array(w * 12).fill(1),
    });
    const ink = [square(16, 8), square(26, 10)];
    const composite = [square(12, 22), square(23, 18)];
    let crops = 0;
    await runFluxInpaint({
      bitmap,
      width,
      height,
      mask: new Uint8Array(width * height).fill(1),
      windows: composite.map((m) => m.bounds),
      runRootDir: createTempDir("qwen-overlapping-credits-"),
      cropStrategy: "worker-resize",
      isolateWindowMasks: true,
      modelMaskIsTypography: true,
      runOptions: {
        windowMasks: ink,
        compositeMasks: composite,
        compositeConstraints: composite,
        illustratedTitleWindows: ["sound:じっ", false],
        maskPaddingPx: 0,
        featherPx: 0,
      },
      getWorker: () => ({
        inpaint: async (request) => {
          const src = images.createFromBuffer(readFileSync(request.input));
          const output = src.toBitmap(),
            mask = images
              .createFromBuffer(readFileSync(request.mask))
              .toBitmap();
          for (let i = 0; i < mask.length; i += 4)
            if (mask[i]) output[i] = crops ? 214 : 162;
          writeFileSync(
            request.output,
            images.createFromBitmap(output, src.getSize()).toPNG(),
          );
          crops++;
        },
      }),
    });
    expect(crops).toBe(2);
    expect(bitmap[(27 * width + 20) * 4]).toBe(162);
    for (let x = 26; x < 36; x++)
      expect(bitmap[(27 * width + x) * 4]).toBe(214);
    expect(bitmap[(27 * width + 24) * 4]).toBe(24);
  });

  it("rejects mismatched or out-of-page priority cores before assigning ownership", async () => {
    const { buildExclusivePaddedWindowMasks } =
      await import("../src/main/inpainting/inpaintingWindowMask");
    const mask = {
      bounds: { x: 0, y: 0, w: 2, h: 2 },
      data: new Uint8Array(4).fill(1),
    };
    expect(() => buildExclusivePaddedWindowMasks([mask], 4, 4, 1, [])).toThrow(
      "priority mask count",
    );
    expect(() =>
      buildExclusivePaddedWindowMasks([mask], 4, 4, 1, [
        { ...mask, bounds: { x: 3, y: 0, w: 2, h: 2 } },
      ]),
    ).toThrow("Invalid block-owned inpainting mask bounds");
    expect(() =>
      buildExclusivePaddedWindowMasks(Array(0xffff).fill(mask), 4, 4, 1),
    ).toThrow("Too many block-owned inpainting masks");
  });
  it("sends a fully selected title to Qwen once, even when a partial selection comes first", async () => {
    const images = createFakeNativeImage();
    vi.doMock("electron", () => ({ nativeImage: images }));
    const { runFluxInpaint } =
      await import("../src/main/inpainting/fluxEngineRunner");
    const width = 64,
      height = 64,
      bitmap = createCoordinateBitmap(width, height);
    const part = {
      bounds: { x: 19, y: 23, w: 9, h: 8 },
      data: new Uint8Array(72).fill(1),
    };
    const whole = {
      bounds: { x: 15, y: 21, w: 28, h: 16 },
      data: new Uint8Array(448).fill(1),
    };
    whole.data[8 * 28 + 20] = 0;
    const windows = [part, whole];
    const counts: number[] = [];
    await runFluxInpaint({
      bitmap,
      width,
      height,
      mask: new Uint8Array(width * height).fill(1),
      windows: windows.map((v) => v.bounds),
      runRootDir: createTempDir("qwen-contained-title-"),
      cropStrategy: "worker-resize",
      isolateWindowMasks: true,
      modelMaskIsTypography: true,
      runOptions: {
        windowMasks: windows,
        compositeMasks: windows,
        compositeConstraints: windows,
        speechBubbleWindows: [false, false],
        illustratedTitleWindows: [true, true],
        featherPx: 0,
        maskPaddingPx: 0,
        requirePixelChange: true,
      },
      getWorker: () => ({
        async inpaint(request) {
          const img = images.createFromBuffer(readFileSync(request.input));
          const data = img.toBitmap(),
            mask = images
              .createFromBuffer(readFileSync(request.mask))
              .toBitmap();
          let active = 0;
          for (let i = 0; i < mask.length; i += 4)
            if (mask[i]) {
              data[i] = 231;
              active++;
            }
          counts.push(active);
          writeFileSync(
            request.output,
            images.createFromBitmap(data, img.getSize()).toPNG(),
          );
        },
      }),
    });
    expect(counts).toEqual([447]);
    expect(bitmap[(27 * width + 21) * 4]).toBe(231);
    expect(bitmap[(29 * width + 35) * 4]).toBe(35);
    expect(bitmap[(21 * width + 14) * 4]).toBe(14);
  });

  it("keeps independently constrained, uncontained or differently feathered selections with their own owner", async () => {
    const { containingTypographyOwners } =
      await import("../src/main/inpainting/inpaintingWindowMask");
    const mask = (x: number, w: number) => ({
      bounds: { x, y: 8, w, h: 4 },
      data: new Uint8Array(w * 4).fill(1),
    });
    const part = mask(11, 3),
      full = mask(9, 10),
      edge = mask(8, 9),
      hole = mask(9, 10);
    hole.data[3] = 0;
    const args = { windowMasks: [part, full], compositeMasks: [part, full] };
    expect(containingTypographyOwners(args)).toEqual([1, 1]);
    expect(
      containingTypographyOwners({ ...args, windowMasks: [part, hole] }),
    ).toEqual([0, 1]);
    expect(
      containingTypographyOwners({ ...args, compositeMasks: [edge, full] }),
    ).toEqual([0, 1]);
    expect(
      containingTypographyOwners({
        ...args,
        compositeConstraints: [null, full],
      }),
    ).toEqual([0, 1]);
    expect(
      containingTypographyOwners({
        ...args,
        compositeConstraints: [part, hole],
      }),
    ).toEqual([0, 1]);
    expect(
      containingTypographyOwners({ ...args, compositeFeatherPx: [2, 6] }),
    ).toEqual([0, 1]);
    expect(
      containingTypographyOwners({
        ...args,
        speechBubbleWindows: [false, true],
      }),
    ).toEqual([0, 1]);
    expect(
      containingTypographyOwners({
        ...args,
        speechBubbleWindows: [true, false],
      }),
    ).toEqual([0, 1]);
    expect(containingTypographyOwners({})).toBeUndefined();
  });
  it("rejects misaligned bubble hints before processing any crop", async () => {
    const { assertFluxMaskContracts } =
      await import("../src/main/inpainting/fluxMaskContracts");
    for (const order of [[0], [0, 0], [-1, 1], [1, 2], [0.5, 1]]) {
      expect(() =>
        assertFluxMaskContracts({
          isolateWindowMasks: true,
          runOptions: { windowProcessingOrder: order },
          windowCount: 2,
        }),
      ).toThrow("Window processing order");
    }
    expect(() =>
      assertFluxMaskContracts({
        isolateWindowMasks: true,
        runOptions: { windowProcessingOrder: [1, 0] },
        windowCount: 2,
      }),
    ).not.toThrow();
    expect(() =>
      assertFluxMaskContracts({
        isolateWindowMasks: false,
        runOptions: { speechBubbleWindows: [true] },
        windowCount: 2,
      }),
    ).toThrow("Speech bubble hint count does not match Flux window count.");
    expect(() =>
      assertFluxMaskContracts({
        isolateWindowMasks: true,
        runOptions: { windowMasks: [] },
        windowCount: 2,
      }),
    ).toThrow("Block-owned mask count does not match Flux window count.");
    expect(() =>
      assertFluxMaskContracts({
        isolateWindowMasks: false,
        runOptions: { compositeMasks: [] },
        windowCount: 2,
      }),
    ).toThrow("Composite mask count does not match Flux window count.");
    expect(() =>
      assertFluxMaskContracts({
        isolateWindowMasks: false,
        runOptions: { windowMasks: [] },
        windowCount: 2,
      }),
    ).not.toThrow();
  });
  it("caps context at 96px only for Metal and keeps CUDA context intact", async () => {
    const runFluxInpaint = vi.fn().mockResolvedValue(undefined);
    vi.doMock("electron", () => ({ nativeImage: createFakeNativeImage() }));

    const { createFluxEngine } =
      await import("../src/main/inpainting/fluxEngine");
    expect(FLUX_INPAINT_CONTEXT_PX).toBe(160);

    const createEngine = (backend: "metal-native" | "cuda-native") =>
      createFluxEngine(
        {
          launch: {
            backend,
            executable: process.execPath,
            args: [],
            runtimePath: "/tmp/runtime",
            label: `test Flux ${backend} worker`,
          },
          runRootDir: "/tmp/run",
        },
        { runInpaint: runFluxInpaint },
      );
    const bitmap = Buffer.alloc(4);
    const mask = new Uint8Array(1).fill(1);
    const windows = [{ x: 0, y: 0, w: 1, h: 1 }];

    await createEngine("metal-native").inpaint(bitmap, 1, 1, mask, windows, {
      contextPx: 200,
    });
    await createEngine("cuda-native").inpaint(bitmap, 1, 1, mask, windows, {
      contextPx: 200,
    });

    expect(runFluxInpaint.mock.calls[0]?.[0].runOptions.contextPx).toBe(96);
    expect(runFluxInpaint.mock.calls[1]?.[0].runOptions.contextPx).toBe(200);
  });

  it.each(["rocm-native", "vulkan-native"] as const)(
    "processes one large region in a single request with the selected pixel budget on %s",
    async (backend) => {
      vi.doMock("electron", () => ({ nativeImage: createFakeNativeImage() }));
      const { createFluxEngine } =
        await import("../src/main/inpainting/fluxEngine");
      const root = createTempDir("mgt-flux-modes-");
      const capture = join(root, "requests.json");
      const worker = join(root, "worker.cjs");
      writeFileSync(worker, createTileCaptureWorkerScript(capture));
      const size = 768;
      const mask = new Uint8Array(size * size).fill(1);
      for (const fluxMode of ["normal", "light"] as const) {
        const engine = createFluxEngine({
          fluxMode,
          diagnostics: createTestDiagnostics(),
          launch: {
            backend,
            executable: process.execPath,
            args: [worker],
            runtimePath: root,
            label: "FLUX mode test",
          },
          runRootDir: root,
        });
        try {
          await engine.inpaint(
            Buffer.alloc(mask.length * 4),
            size,
            size,
            mask,
            [{ x: 0, y: 0, w: size, h: size }],
            { requirePixelChange: false },
          );
        } finally {
          await engine.dispose();
        }
      }
      expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual([
        expect.objectContaining({ steps: 4, maxPixels: 1024 * 1024 }),
        expect.objectContaining({
          width: size,
          height: size,
          steps: 3,
          maxPixels: 384 * 384,
        }),
      ]);
    },
  );

  it("uses conservative crop tiling for the SM75 FP16 CUDA path", async () => {
    const runFluxInpaint = vi.fn().mockResolvedValue(undefined);
    vi.doMock("electron", () => ({ nativeImage: createFakeNativeImage() }));
    const { createFluxEngine } =
      await import("../src/main/inpainting/fluxEngine");
    const engine = createFluxEngine(
      {
        launch: {
          backend: "cuda-native",
          executable: process.execPath,
          args: [],
          runtimePath: "/tmp/runtime",
          label: "test Flux SM75 worker",
        },
        runRootDir: "/tmp/run",
        sm75Fp16Enabled: true,
      },
      { runInpaint: runFluxInpaint },
    );

    await engine.inpaint(Buffer.alloc(4), 1, 1, new Uint8Array(1).fill(1), [
      { x: 0, y: 0, w: 1, h: 1 },
    ]);

    expect(runFluxInpaint.mock.calls[0]?.[0].cropStrategy).toBe("native-tiled");
  });

  it("uses conservative crop tiling for the CPU compatibility path", async () => {
    const runFluxInpaint = vi.fn().mockResolvedValue(undefined);
    vi.doMock("electron", () => ({ nativeImage: createFakeNativeImage() }));
    const { createFluxEngine } =
      await import("../src/main/inpainting/fluxEngine");
    const engine = createFluxEngine(
      {
        launch: {
          backend: "cpu-native",
          executable: process.execPath,
          args: [],
          runtimePath: "/tmp/runtime",
          label: "test Flux CPU worker",
        },
        runRootDir: "/tmp/run",
      },
      { runInpaint: runFluxInpaint },
    );

    await engine.inpaint(Buffer.alloc(4), 1, 1, new Uint8Array(1).fill(1), [
      { x: 0, y: 0, w: 1, h: 1 },
    ]);

    expect(runFluxInpaint.mock.calls[0]?.[0].cropStrategy).toBe("native-tiled");
  });

  it("keeps small crops at their native aligned size", () => {
    const size = resolveFluxProcessSize(320, 160, 1024 * 1024, 16);

    expect(size).toEqual({ width: 320, height: 160 });
  });

  it("downscales crops that exceed the model pixel budget", () => {
    const size = resolveFluxProcessSize(2048, 1024, 1024 * 1024, 16);

    expect(size.width).toBeLessThan(2048);
    expect(size.height).toBeLessThan(1024);
    expect(size.width % 16).toBe(0);
    expect(size.height % 16).toBe(0);
    expect(size.width * size.height).toBeLessThanOrEqual(1024 * 1024);
    expect(size.width / size.height).toBeCloseTo(2, 1);
  });

  it("caps a long crop dimension without upscaling the other dimension", () => {
    const size = resolveFluxProcessSize(4096, 128, 1024 * 1024, 16);

    expect(size).toEqual({ width: 2048, height: 64 });
  });

  it("keeps small Metal crops whole at their native size", () => {
    const tiles = resolveContextTiles(
      { x: 80, y: 96, w: 320, h: 208 },
      1200,
      1600,
      512,
      112,
      16,
    );

    expect(tiles).toEqual([
      {
        cropBounds: { x: 80, y: 96, w: 320, h: 208 },
        writeBounds: { x: 80, y: 96, w: 320, h: 208 },
      },
    ]);
  });

  it("splits large Metal crops into overlapping context tiles capped at 512", () => {
    const bounds = { x: 64, y: 48, w: 920, h: 700 };
    const tiles = resolveContextTiles(bounds, 1200, 1000, 512, 112, 16);

    expect(tiles.length).toBeGreaterThan(1);
    expect(
      tiles.every(
        ({ cropBounds }) => cropBounds.w <= 512 && cropBounds.h <= 512,
      ),
    ).toBe(true);
    expect(
      tiles.reduce(
        (area, { writeBounds }) => area + writeBounds.w * writeBounds.h,
        0,
      ),
    ).toBe(bounds.w * bounds.h);
    for (const { cropBounds, writeBounds } of tiles) {
      expect(cropBounds.x).toBeLessThanOrEqual(writeBounds.x);
      expect(cropBounds.y).toBeLessThanOrEqual(writeBounds.y);
      expect(cropBounds.x + cropBounds.w).toBeGreaterThanOrEqual(
        writeBounds.x + writeBounds.w,
      );
      expect(cropBounds.y + cropBounds.h).toBeGreaterThanOrEqual(
        writeBounds.y + writeBounds.h,
      );
    }
  });

  it("sends large Metal crops as native-resolution 512px tiles", async () => {
    vi.doMock("electron", () => ({ nativeImage: createFakeNativeImage() }));

    const { createFluxEngine } =
      await import("../src/main/inpainting/fluxEngine");
    const root = createTempDir("mgt-flux-metal-tiles-");
    const capturePath = join(root, "requests.json");
    const workerPath = join(root, "capture-worker.cjs");
    writeFileSync(
      workerPath,
      createTileCaptureWorkerScript(capturePath),
      "utf8",
    );
    const engine = createFluxEngine({
      diagnostics: createTestDiagnostics(),
      launch: {
        backend: "metal-native",
        executable: process.execPath,
        args: [workerPath],
        runtimePath: root,
        label: "test Flux Metal worker",
      },
      runRootDir: root,
    });
    const width = 900;
    const height = 256;
    const bitmap = Buffer.alloc(width * height * 4, 180);
    const mask = new Uint8Array(width * height).fill(1);

    await engine.inpaint(
      bitmap,
      width,
      height,
      mask,
      [{ x: 0, y: 0, w: width, h: height }],
      {
        contextPx: 16,
        featherPx: 0,
        maskPaddingPx: 0,
        maxPixels: 1024 * 1024,
      },
    );
    await engine.dispose();

    const requests = JSON.parse(readFileSync(capturePath, "utf8")) as Array<{
      height: number;
      maxPixels: number;
      width: number;
    }>;
    expect(requests).toHaveLength(2);
    expect(
      requests.every(
        (request) => request.width <= 512 && request.height <= 512,
      ),
    ).toBe(true);
    expect(
      requests.every(
        (request) => request.maxPixels === request.width * request.height,
      ),
    ).toBe(true);
  });

  it.each(["metal-native", "cuda-native"] as const)(
    "reserves each %s write core before overlapping model context can steal it",
    async (backend) => {
      vi.doMock("electron", () => ({ nativeImage: createFakeNativeImage() }));

      const { createFluxEngine } =
        await import("../src/main/inpainting/fluxEngine");
      const root = createTempDir("mgt-flux-owned-masks-");
      const capturePath = join(root, "requests.json");
      const workerPath = join(root, "capture-worker.cjs");
      writeFileSync(
        workerPath,
        createMaskCaptureWorkerScript(capturePath),
        "utf8",
      );
      const engine = createFluxEngine({
        diagnostics: createTestDiagnostics(),
        launch: {
          backend,
          executable: process.execPath,
          args: [workerPath],
          runtimePath: root,
          label: "test Flux Metal worker",
        },
        runRootDir: root,
      });
      const width = 128;
      const height = 64;
      const bitmap = createCoordinateBitmap(width, height);
      const mask = new Uint8Array(width * height);
      mask[32 * width + 48] = 1;
      mask[32 * width + 64] = 1;
      const ownedMasks = [
        {
          bounds: { x: 48, y: 32, w: 1, h: 1 },
          data: Uint8Array.of(1),
        },
        {
          bounds: { x: 64, y: 32, w: 1, h: 1 },
          data: Uint8Array.of(1),
        },
      ];

      await engine.inpaint(
        bitmap,
        width,
        height,
        mask,
        [
          { x: 16, y: 16, w: 80, h: 32 },
          { x: 32, y: 16, w: 80, h: 32 },
        ],
        {
          contextPx: 16,
          featherPx: 0,
          maskPaddingPx: 16,
          maxPixels: 256 * 256,
          windowMasks: [
            {
              bounds: { x: 32, y: 16, w: 48, h: 32 },
              data: new Uint8Array(48 * 32).fill(1),
            },
            {
              bounds: { x: 48, y: 16, w: 48, h: 32 },
              data: new Uint8Array(48 * 32).fill(1),
            },
          ],
          compositeMasks: ownedMasks,
          speechBubbleWindows: [true, false],
          ...(backend === "cuda-native"
            ? { compositeConstraints: ownedMasks }
            : {}),
        },
      );
      await engine.dispose();

      const requests = JSON.parse(readFileSync(capturePath, "utf8")) as Array<{
        activePixels: string[];
        speechBubble: boolean;
      }>;
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.speechBubble)).toEqual([
        true,
        false,
      ]);
      expect(requests[0].activePixels).toContain("48,32");
      expect(requests[1].activePixels).toContain("64,32");
      expect(requests.every((request) => request.activePixels.length > 1)).toBe(
        true,
      );
      const firstPixels = new Set(requests[0].activePixels);
      expect(
        requests[1].activePixels.some((pixel) => firstPixels.has(pixel)),
      ).toBe(false);
    },
  );

  it("accepts a fully contained target mask handled by an earlier crop", async () => {
    const logWarn = vi.fn();
    vi.doMock("electron", () => ({ nativeImage: createFakeNativeImage() }));

    const { createFluxEngine } =
      await import("../src/main/inpainting/fluxEngine");
    const root = createTempDir("mgt-flux-contained-mask-");
    const capturePath = join(root, "request-count.txt");
    const workerPath = join(root, "changing-worker.cjs");
    writeFileSync(
      workerPath,
      createMaskChangingWorkerScript(capturePath),
      "utf8",
    );
    const engine = createFluxEngine({
      diagnostics: { info: vi.fn(), warn: logWarn },
      launch: {
        backend: "cuda-native",
        executable: process.execPath,
        args: [workerPath],
        runtimePath: root,
        label: "test Flux worker",
      },
      runRootDir: root,
    });
    const width = 64;
    const height = 64;
    const bitmap = Buffer.alloc(width * height * 4, 180);
    const mask = new Uint8Array(width * height);
    const outer = {
      bounds: { x: 16, y: 16, w: 16, h: 16 },
      data: new Uint8Array(16 * 16).fill(1),
    };
    const inner = {
      bounds: { x: 20, y: 20, w: 4, h: 4 },
      data: new Uint8Array(4 * 4).fill(1),
    };
    // A real target has source ink. An empty flat mask correctly stays unchanged.
    for (let y = 20; y < 24; y++) {
      for (let x = 20; x < 24; x++)
        bitmap.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
    }
    for (let y = 16; y < 32; y += 1) {
      mask.fill(1, y * width + 16, y * width + 32);
    }

    await expect(
      engine.inpaint(
        bitmap,
        width,
        height,
        mask,
        [outer.bounds, inner.bounds],
        {
          contextPx: 16,
          featherPx: 0,
          maskPaddingPx: 0,
          maxPixels: 256 * 256,
          windowMasks: [outer, inner],
          compositeConstraints: [outer, inner],
          compositeMasks: [outer, inner],
          requirePixelChange: true,
        },
      ),
    ).resolves.toBeUndefined();
    await engine.dispose();

    expect(readFileSync(capturePath, "utf8")).toBe("1");
    expect(bitmap[(20 * width + 20) * 4]).toBe(180);
    expect(logWarn).not.toHaveBeenCalledWith(
      expect.stringContaining("skipped"),
      expect.anything(),
    );
  });

  it("sends zero runner padding after expanding the mask in the app", async () => {
    vi.doMock("electron", () => ({ nativeImage: createFakeNativeImage() }));

    const { createFluxEngine } =
      await import("../src/main/inpainting/fluxEngine");
    const root = createTempDir("mgt-flux-mask-padding-");
    const capturePath = join(root, "request.json");
    const workerPath = join(root, "copy-worker.cjs");
    writeFileSync(workerPath, createCopyWorkerScript(capturePath), "utf8");
    const engine = createFluxEngine({
      diagnostics: createTestDiagnostics(),
      launch: {
        backend: "cuda-native",
        executable: process.execPath,
        args: [workerPath],
        runtimePath: root,
        label: "test Flux worker",
      },
      runRootDir: root,
    });
    const bitmap = Buffer.alloc(64 * 64 * 4, 180);
    const mask = new Uint8Array(64 * 64);
    mask[32 * 64 + 32] = 1;

    await engine.inpaint(bitmap, 64, 64, mask, [{ x: 32, y: 32, w: 1, h: 1 }], {
      contextPx: 16,
      maskPaddingPx: 16,
    });
    await engine.dispose();

    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
      activeMaskPixels: number;
      maskPadding: number;
    };
    expect(capture.maskPadding).toBe(0);
    expect(capture.activeMaskPixels).toBeGreaterThan(1);
  });

  it("fails when every crop comes back unchanged", async () => {
    const logWarn = vi.fn();
    vi.doMock("electron", () => ({ nativeImage: createFakeNativeImage() }));

    const { createFluxEngine } =
      await import("../src/main/inpainting/fluxEngine");
    const root = createTempDir("mgt-flux-engine-");
    const workerPath = join(root, "copy-worker.cjs");
    writeFileSync(workerPath, createCopyWorkerScript(), "utf8");
    const engine = createFluxEngine({
      diagnostics: { info: vi.fn(), warn: logWarn },
      launch: {
        backend: "cuda-native",
        executable: process.execPath,
        args: [workerPath],
        runtimePath: root,
        label: "test Flux worker",
      },
      runRootDir: root,
    });
    const bitmap = Buffer.alloc(256 * 256 * 4, 180);
    const mask = new Uint8Array(256 * 256).fill(1);

    await expect(
      engine.inpaint(bitmap, 256, 256, mask, [{ x: 0, y: 0, w: 256, h: 256 }], {
        contextPx: 16,
        maskPaddingPx: 0,
        maxPixels: 256 * 256,
        requirePixelChange: true,
      }),
    ).rejects.toThrow("인페인팅 결과가 생성되지 않았습니다.");
    await engine.dispose();

    expect(logWarn).toHaveBeenCalledWith(
      "Flux inpainting left every masked crop effectively unchanged",
      expect.objectContaining({
        processedWindows: 1,
      }),
    );
  });

  it("does not treat small real pixel changes as a true no-op", async () => {
    vi.doMock("electron", () => ({ nativeImage: createFakeNativeImage() }));

    const { isMaskedRegionEffectivelyUnchanged } =
      await import("../src/main/inpainting/fluxChangeStats");

    expect(
      isMaskedRegionEffectivelyUnchanged({
        changedPixels: 12,
        changedRatio: 0.0034,
        meanDelta: 1.47,
      }),
    ).toBe(false);
  });
});

function createTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  tempDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createTestDiagnostics() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createCopyWorkerScript(capturePath?: string): string {
  return `
const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "shutdown") {
    process.exit(0);
  }
  ${
    capturePath
      ? `
  const maskFile = fs.readFileSync(request.mask);
  const newline = maskFile.indexOf(10);
  const maskBitmap = maskFile.subarray(newline + 1);
  let activeMaskPixels = 0;
  for (let offset = 0; offset < maskBitmap.length; offset += 4) {
    if (maskBitmap[offset] > 0) activeMaskPixels += 1;
  }
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
    maskPadding: request.mask_padding,
    activeMaskPixels,
  }));
  `
      : ""
  }
  fs.copyFileSync(request.input, request.output);
  process.stdout.write(JSON.stringify({ id: request.id, ok: true }) + "\\n");
});
`;
}

function createTileCaptureWorkerScript(capturePath: string): string {
  return `
const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "shutdown") {
    process.exit(0);
  }
  const input = fs.readFileSync(request.input);
  const newline = input.indexOf(10);
  const header = JSON.parse(input.subarray(0, newline).toString("utf8"));
  const requests = fs.existsSync(${JSON.stringify(capturePath)})
    ? JSON.parse(fs.readFileSync(${JSON.stringify(capturePath)}, "utf8"))
    : [];
  requests.push({
    width: header.width,
    height: header.height,
    maxPixels: request.max_pixels,
    steps: request.steps,
  });
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(requests));
  fs.copyFileSync(request.input, request.output);
  process.stdout.write(JSON.stringify({ id: request.id, ok: true }) + "\\n");
});
`;
}

function createMaskCaptureWorkerScript(capturePath: string): string {
  return `
const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "shutdown") {
    process.exit(0);
  }
  const inputFile = fs.readFileSync(request.input);
  const inputNewline = inputFile.indexOf(10);
  const inputHeader = JSON.parse(inputFile.subarray(0, inputNewline).toString("utf8"));
  const inputBitmap = inputFile.subarray(inputNewline + 1);
  const originX = inputBitmap[0];
  const originY = inputBitmap[1];
  const maskFile = fs.readFileSync(request.mask);
  const newline = maskFile.indexOf(10);
  const maskBitmap = maskFile.subarray(newline + 1);
  const activePixels = [];
  for (let offset = 0; offset < maskBitmap.length; offset += 4) {
    if (maskBitmap[offset] === 0) continue;
    const pixel = offset / 4;
    activePixels.push(
      String(originX + (pixel % inputHeader.width)) + "," +
      String(originY + Math.floor(pixel / inputHeader.width)),
    );
  }
  const requests = fs.existsSync(${JSON.stringify(capturePath)})
    ? JSON.parse(fs.readFileSync(${JSON.stringify(capturePath)}, "utf8"))
    : [];
  requests.push({ activePixels, speechBubble: request.speech_bubble,
    inputHash: require("node:crypto").createHash("sha256").update(inputFile).digest("hex") });
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(requests));
  fs.copyFileSync(request.input, request.output);
  process.stdout.write(JSON.stringify({ id: request.id, ok: true }) + "\\n");
});
`;
}

function createMaskChangingWorkerScript(capturePath: string): string {
  return `
const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "shutdown") {
    process.exit(0);
  }
  const inputFile = fs.readFileSync(request.input);
  const inputNewline = inputFile.indexOf(10);
  const inputBitmap = Buffer.from(inputFile.subarray(inputNewline + 1));
  const maskFile = fs.readFileSync(request.mask);
  const maskNewline = maskFile.indexOf(10);
  const maskBitmap = maskFile.subarray(maskNewline + 1);
  for (let offset = 0; offset < maskBitmap.length; offset += 4) {
    if (maskBitmap[offset] === 0) continue;
    inputBitmap[offset] = 0;
    inputBitmap[offset + 1] = 0;
    inputBitmap[offset + 2] = 0;
  }
  fs.writeFileSync(
    request.output,
    Buffer.concat([inputFile.subarray(0, inputNewline + 1), inputBitmap]),
  );
  const requestCount = fs.existsSync(${JSON.stringify(capturePath)})
    ? Number(fs.readFileSync(${JSON.stringify(capturePath)}, "utf8"))
    : 0;
  fs.writeFileSync(${JSON.stringify(capturePath)}, String(requestCount + 1));
  process.stdout.write(JSON.stringify({ id: request.id, ok: true }) + "\\n");
});
`;
}

function createCoordinateBitmap(width: number, height: number): Buffer {
  const bitmap = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      bitmap[offset] = x;
      bitmap[offset + 1] = y;
      bitmap[offset + 2] = 180;
      bitmap[offset + 3] = 255;
    }
  }
  return bitmap;
}

function createFakeNativeImage(): {
  createFromBitmap: (
    bitmap: Buffer,
    size: { width: number; height: number },
  ) => FakeImage;
  createFromBuffer: (buffer: Buffer) => FakeImage;
  createFromPath: () => FakeImage;
} {
  return {
    createFromBitmap: (bitmap, size) =>
      new FakeImage(Buffer.from(bitmap), size.width, size.height),
    createFromBuffer: (buffer) => FakeImage.fromBuffer(buffer),
    createFromPath: () => FakeImage.empty(),
  };
}

class FakeImage {
  static empty(): FakeImage {
    return new FakeImage(Buffer.alloc(0), 0, 0, true);
  }

  static fromBuffer(buffer: Buffer): FakeImage {
    const newline = buffer.indexOf(10);
    if (newline < 0) {
      return FakeImage.empty();
    }
    const header = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as {
      width: number;
      height: number;
    };
    return new FakeImage(
      Buffer.from(buffer.subarray(newline + 1)),
      header.width,
      header.height,
    );
  }

  constructor(
    private readonly bitmap: Buffer,
    private readonly width: number,
    private readonly height: number,
    private readonly empty = false,
  ) {}

  isEmpty(): boolean {
    return this.empty;
  }

  resize(size: { width: number; height: number }): FakeImage {
    if (size.width === this.width && size.height === this.height) {
      return this;
    }
    return new FakeImage(
      Buffer.alloc(size.width * size.height * 4, 0),
      size.width,
      size.height,
      this.empty,
    );
  }

  getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  toBitmap(): Buffer {
    return Buffer.from(this.bitmap);
  }

  toPNG(): Buffer {
    const header = Buffer.from(
      `${JSON.stringify({ width: this.width, height: this.height })}\n`,
      "utf8",
    );
    return Buffer.concat([header, this.bitmap]);
  }
}
