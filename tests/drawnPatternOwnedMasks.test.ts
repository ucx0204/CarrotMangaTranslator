import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  InpaintingEngine,
  InpaintingWindowMask,
} from "../src/main/inpainting/inpaintingEngine";
import type { MangaPage } from "../src/shared/libraryTypes";

const tempDirs: string[] = [];

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("drawn-pattern block-owned masks", () => {
  it("passes one owned mask per overlapping Metal component window", async () => {
    const width = 96;
    const height = 64;
    const inputImage = new FakeImage(
      Buffer.alloc(width * height * 4, 180),
      width,
      height,
    );
    vi.doMock("electron", () => ({
      nativeImage: {
        createFromBitmap: (
          bitmap: Buffer,
          size: { width: number; height: number },
        ) => new FakeImage(Buffer.from(bitmap), size.width, size.height),
        createFromBuffer: () => FakeImage.empty(),
        createFromPath: () => inputImage,
      },
    }));
    const inpaint = vi.fn<InpaintingEngine["inpaint"]>(
      async (bitmap: Parameters<InpaintingEngine["inpaint"]>[0]) => {
        const changedPoints: Array<[number, number]> = [
          [32, 32],
          [48, 32],
        ];
        for (const [x, y] of changedPoints) {
          const offset = (y * width + x) * 4;
          bitmap[offset] = 0;
          bitmap[offset + 1] = 0;
          bitmap[offset + 2] = 0;
        }
      },
    );
    const engine: InpaintingEngine = {
      model: "flux-klein",
      runtimePath: "test-runtime",
      backend: "metal-native",
      runRootDir: "test-runs",
      inpaint,
      dispose: async () => {},
    };
    const root = createTempDir("mgt-drawn-owned-masks-");
    const page = createPage(
      join(root, "chapter", "images", "page.png"),
      width,
      height,
    );
    const { inpaintDrawnPatternPage } =
      await import("../src/main/inpainting/drawnPatternPage");

    const result = await inpaintDrawnPatternPage(page, {
      inpaintingEngine: engine,
      strokes: [
        { points: [{ x: 32, y: 32 }], radiusPx: 2 },
        { points: [{ x: 48, y: 32 }], radiusPx: 2 },
      ],
    });

    expect(result.blocksErased).toBe(2);
    expect(inpaint).toHaveBeenCalledOnce();
    const call = inpaint.mock.calls[0];
    const pageMask = call[3];
    const windows = call[4];
    const windowMasks = call[5]?.windowMasks;
    expect(windows).toHaveLength(2);
    expect(rectsOverlap(windows[0], windows[1])).toBe(true);
    expect(windowMasks).toHaveLength(2);
    expect(maskValueAt(windowMasks?.[0], 32, 32)).toBe(1);
    expect(maskValueAt(windowMasks?.[0], 48, 32)).toBe(0);
    expect(maskValueAt(windowMasks?.[1], 32, 32)).toBe(0);
    expect(maskValueAt(windowMasks?.[1], 48, 32)).toBe(1);
    expect(pageMask[32 * width + 32]).toBe(1);
    expect(pageMask[32 * width + 48]).toBe(1);
  });

  it("returns no result when the engine leaves a drawn mask unchanged", async () => {
    const width = 64;
    const height = 64;
    const inputImage = new FakeImage(
      Buffer.alloc(width * height * 4, 180),
      width,
      height,
    );
    vi.doMock("electron", () => ({
      nativeImage: {
        createFromBitmap: (
          bitmap: Buffer,
          size: { width: number; height: number },
        ) => new FakeImage(Buffer.from(bitmap), size.width, size.height),
        createFromBuffer: () => FakeImage.empty(),
        createFromPath: () => inputImage,
      },
    }));
    const inpaint = vi.fn<InpaintingEngine["inpaint"]>(async () => undefined);
    const engine: InpaintingEngine = {
      model: "lama-manga",
      runtimePath: "test-runtime",
      backend: "cpu",
      runRootDir: "test-runs",
      inpaint,
      dispose: async () => undefined,
    };
    const root = createTempDir("mgt-drawn-no-change-");
    const page = createPage(
      join(root, "chapter", "images", "page.png"),
      width,
      height,
    );
    const { inpaintDrawnPatternPage } =
      await import("../src/main/inpainting/drawnPatternPage");

    const result = await inpaintDrawnPatternPage(page, {
      inpaintingEngine: engine,
      strokes: [{ points: [{ x: 32, y: 32 }], radiusPx: 3 }],
    });

    expect(result).toEqual({ page, blocksErased: 0 });
    expect(inpaint).toHaveBeenCalledWith(
      expect.any(Buffer),
      width,
      height,
      expect.any(Uint8Array),
      expect.any(Array),
      expect.objectContaining({ requirePixelChange: true }),
    );
  });
});

function createTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function createPage(
  imagePath: string,
  width: number,
  height: number,
): MangaPage {
  return {
    id: "page-1",
    name: "page.png",
    imagePath,
    dataUrl: "",
    width,
    height,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function maskValueAt(
  windowMask: InpaintingWindowMask | undefined,
  x: number,
  y: number,
): number {
  if (!windowMask) return 0;
  const { bounds, data } = windowMask;
  if (
    x < bounds.x ||
    x >= bounds.x + bounds.w ||
    y < bounds.y ||
    y >= bounds.y + bounds.h
  ) {
    return 0;
  }
  return data[(y - bounds.y) * bounds.w + x - bounds.x] ?? 0;
}

function rectsOverlap(
  left: { x: number; y: number; w: number; h: number },
  right: { x: number; y: number; w: number; h: number },
): boolean {
  return (
    left.x < right.x + right.w &&
    left.x + left.w > right.x &&
    left.y < right.y + right.h &&
    left.y + left.h > right.y
  );
}

class FakeImage {
  static empty(): FakeImage {
    return new FakeImage(Buffer.alloc(0), 0, 0, true);
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

  getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  toBitmap(): Buffer {
    return Buffer.from(this.bitmap);
  }

  toPNG(): Buffer {
    return Buffer.from(this.bitmap);
  }
}
