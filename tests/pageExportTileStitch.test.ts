import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { probeImageBuffer } from "../src/main/libraryStore/imageHeaderProbe";
import {
  buildPageExportTileFfmpegArgs,
  createPageExportTilePlan,
  stitchPageExportTilesWithFfmpeg,
  type PageExportCapturedTile,
  type PageExportTileStitchRequest,
} from "../src/main/pageExportTileStitch";
import { SAFE_PAGE_EXPORT_RASTER_LIMITS } from "../src/shared/pageExportLimits";

const tempDirectories: string[] = [];

afterEach(async () => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory) await rm(directory, { force: true, recursive: true });
  }
});

describe("page export tile stitching", () => {
  it("covers the issue #80 dimensions with contiguous overlapping 2D tiles", () => {
    const expected = { width: 4445, height: 6053 };
    const tiles = createPageExportTilePlan(expected);

    expect(tiles).toHaveLength(4);
    expect(
      tiles.reduce(
        (pixels, tile) => pixels + tile.outputWidth * tile.outputHeight,
        0,
      ),
    ).toBe(expected.width * expected.height);
    expect(new Set(tiles.map((tile) => tile.outputX)).size).toBe(2);
    expect(new Set(tiles.map((tile) => tile.outputY)).size).toBe(2);
    for (const tile of tiles) {
      expect(Number.isInteger(tile.captureX)).toBe(true);
      expect(Number.isInteger(tile.captureY)).toBe(true);
      expect(Number.isInteger(tile.captureWidth)).toBe(true);
      expect(Number.isInteger(tile.captureHeight)).toBe(true);
      expect(tile.captureWidth).toBeLessThanOrEqual(4096);
      expect(tile.captureHeight).toBeLessThanOrEqual(4096);
      expect(tile.captureWidth * tile.captureHeight).toBeLessThanOrEqual(
        SAFE_PAGE_EXPORT_RASTER_LIMITS.maxPixels,
      );
      if (tile.outputX > 0) expect(tile.captureX).toBeLessThan(tile.outputX);
      if (tile.outputY > 0) expect(tile.captureY).toBeLessThan(tile.outputY);
    }
  });

  it("crops overlaps and reconstructs every source pixel exactly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "page-export-stitch-"));
    tempDirectories.push(directory);
    const source = createPatternPng(9, 8);
    const plan = createPageExportTilePlan(
      { width: source.width, height: source.height },
      { maxPixels: 25, maxSidePx: 5 },
      1,
    );
    const tiles: PageExportCapturedTile[] = [];
    for (const tile of plan) {
      const path = join(directory, `tile-${tile.index}.png`);
      await writeFile(path, encodeSourceTile(source, tile));
      tiles.push({ ...tile, path });
    }
    const outputPath = join(directory, "stitched.png");
    const request = {
      expected: { width: source.width, height: source.height },
      format: "png" as const,
      outputPath,
      tiles,
    };
    const args = buildPageExportTileFfmpegArgs(request);
    expect(args.join(" ")).toContain("hstack=inputs=3");
    expect(args.join(" ")).toContain("vstack=inputs=3");

    await stitchPageExportTilesWithFfmpeg(request, resolveTestFfmpegPath());

    const stitched = PNG.sync.read(await readFile(outputPath));
    expect({ width: stitched.width, height: stitched.height }).toEqual(
      request.expected,
    );
    expect(stitched.data.equals(source.data)).toBe(true);
  });

  it.each([
    { extension: "jpg", format: "jpeg" as const },
    { extension: "webp", format: "webp" as const },
  ])(
    "encodes the stitched image once as $format",
    async ({ extension, format }) => {
      const directory = await mkdtemp(join(tmpdir(), "page-export-stitch-"));
      tempDirectories.push(directory);
      const source = createPatternPng(10, 9);
      const plan = createPageExportTilePlan(
        { width: source.width, height: source.height },
        { maxPixels: 36, maxSidePx: 6 },
        1,
      );
      const tiles: PageExportCapturedTile[] = [];
      for (const tile of plan) {
        const path = join(directory, `tile-${tile.index}.png`);
        await writeFile(path, encodeSourceTile(source, tile));
        tiles.push({ ...tile, path });
      }
      const request: PageExportTileStitchRequest = {
        expected: { width: source.width, height: source.height },
        format,
        outputPath: join(directory, `stitched.${extension}`),
        quality: 87,
        tiles,
      };

      await stitchPageExportTilesWithFfmpeg(request, resolveTestFfmpegPath());

      const metadata = probeImageBuffer(
        await readFile(request.outputPath),
        request.outputPath,
        { maxWidth: 100, maxHeight: 100, maxPixels: 10_000 },
      );
      expect({
        format: metadata.format,
        width: metadata.width,
        height: metadata.height,
      }).toEqual({ format, ...request.expected });
    },
  );
});

function createPatternPng(width: number, height: number): PNG {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      png.data[offset] = (x * 29 + y * 17) % 256;
      png.data[offset + 1] = (x * 11 + y * 31) % 256;
      png.data[offset + 2] = (x * 7 + y * 13) % 256;
      png.data[offset + 3] = 255;
    }
  }
  return png;
}

function encodeSourceTile(
  source: PNG,
  tile: ReturnType<typeof createPageExportTilePlan>[number],
): Buffer {
  const png = new PNG({
    width: tile.captureWidth,
    height: tile.captureHeight,
  });
  const tileRowBytes = tile.captureWidth * 4;
  for (let row = 0; row < tile.captureHeight; row += 1) {
    const sourceOffset =
      ((tile.captureY + row) * source.width + tile.captureX) * 4;
    source.data.copy(
      png.data,
      row * tileRowBytes,
      sourceOffset,
      sourceOffset + tileRowBytes,
    );
  }
  return PNG.sync.write(png);
}

function resolveTestFfmpegPath(): string {
  const ffmpegPath: unknown = require("ffmpeg-static");
  if (typeof ffmpegPath !== "string" || ffmpegPath.length < 1) {
    throw new Error("ffmpeg-static is unavailable for the stitch test.");
  }
  return ffmpegPath;
}
