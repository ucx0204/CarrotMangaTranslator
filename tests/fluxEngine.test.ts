import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFluxProcessSize } from "../src/main/inpainting/maskGeometry";

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

  it("sends zero runner padding after expanding the mask in the app", async () => {
    vi.doMock("electron", () => ({ nativeImage: createFakeNativeImage() }));
    vi.doMock("../src/main/logger", () => ({
      logInfo: vi.fn(),
      logWarn: vi.fn(),
    }));

    const { createFluxEngine } =
      await import("../src/main/inpainting/fluxEngine");
    const root = createTempDir("mgt-flux-mask-padding-");
    const capturePath = join(root, "request.json");
    const workerPath = join(root, "copy-worker.cjs");
    writeFileSync(workerPath, createCopyWorkerScript(capturePath), "utf8");
    const engine = createFluxEngine({
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

  it("warns instead of failing when every crop comes back unchanged", async () => {
    const logInfo = vi.fn();
    const logWarn = vi.fn();
    vi.doMock("electron", () => ({ nativeImage: createFakeNativeImage() }));
    vi.doMock("../src/main/logger", () => ({ logInfo, logWarn }));

    const { createFluxEngine } =
      await import("../src/main/inpainting/fluxEngine");
    const root = createTempDir("mgt-flux-engine-");
    const workerPath = join(root, "copy-worker.cjs");
    writeFileSync(workerPath, createCopyWorkerScript(), "utf8");
    const engine = createFluxEngine({
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
      }),
    ).resolves.toBeUndefined();
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
    vi.doMock("../src/main/logger", () => ({
      logInfo: vi.fn(),
      logWarn: vi.fn(),
    }));

    const { isMaskedRegionEffectivelyUnchanged } =
      await import("../src/main/inpainting/fluxEngine");

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
