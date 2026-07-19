import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  it("upscales small crops to the model pixel budget", () => {
    const size = resolveFluxProcessSize(320, 160, 1024 * 1024, 16);

    expect(size.width).toBeGreaterThan(320);
    expect(size.height).toBeGreaterThan(160);
    expect(size.width % 16).toBe(0);
    expect(size.height % 16).toBe(0);
    expect(size.width * size.height).toBeLessThanOrEqual(1024 * 1024);
    expect(size.width / size.height).toBeCloseTo(2, 1);
  });

  it("matches generated crop tone to the unchanged context", async () => {
    vi.doMock("electron", () => ({ nativeImage: createFakeNativeImage() }));
    const { matchFluxOutputToOriginalContext } = await import(
      "../src/main/inpainting/fluxToneCorrection"
    );
    const original = Buffer.alloc(16 * 16 * 4);
    const generated = Buffer.alloc(16 * 16 * 4);
    const mask = new Uint8Array(16 * 16);
    for (let index = 0; index < 16 * 16; index += 1) {
      const offset = index * 4;
      original.set([180, 180, 180, 255], offset);
      generated.set([90, 120, 150, 255], offset);
      const x = index % 16;
      const y = Math.floor(index / 16);
      mask[index] = x >= 6 && x < 10 && y >= 6 && y < 10 ? 1 : 0;
    }

    expect(
      matchFluxOutputToOriginalContext(original, generated, mask),
    ).toBe(true);
    const maskedOffset = (7 * 16 + 7) * 4;
    expect([...generated.subarray(maskedOffset, maskedOffset + 3)]).toEqual([
      180, 180, 180,
    ]);
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
      engine.inpaint(
        bitmap,
        256,
        256,
        mask,
        [{ x: 0, y: 0, w: 256, h: 256 }],
        {
          contextPx: 16,
          maskPaddingPx: 0,
          maxPixels: 256 * 256,
        },
      ),
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

function createCopyWorkerScript(): string {
  return `
const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "shutdown") {
    process.exit(0);
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
