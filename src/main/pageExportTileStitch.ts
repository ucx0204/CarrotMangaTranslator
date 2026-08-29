import { spawn } from "node:child_process";
import {
  SAFE_PAGE_EXPORT_RASTER_LIMITS,
  validatePageExportRasterSize,
  type PageExportRasterLimits,
  type PageExportRasterSize,
} from "../shared/pageExportLimits";
import { getAppPaths } from "./appPaths";
import {
  assertRuntimeFunctions,
  loadAppRuntimeModule,
} from "./runtimeModuleLoader";

const PAGE_EXPORT_TILE_OVERLAP_PX = 8;
export const PAGE_EXPORT_CAPTURE_TILE_SIDE_PX = 4096;
const PAGE_EXPORT_STITCH_TIMEOUT_MS = 10 * 60_000;
const MAX_FFMPEG_ERROR_CHARS = 16_384;

export type PageExportTile = {
  index: number;
  captureX: number;
  captureY: number;
  captureWidth: number;
  captureHeight: number;
  outputX: number;
  outputY: number;
  outputWidth: number;
  outputHeight: number;
  cropLeft: number;
  cropTop: number;
};

export type PageExportCapturedTile = PageExportTile & {
  path: string;
};

export type PageExportTileStitchRequest = {
  expected: PageExportRasterSize;
  format: "png" | "jpeg" | "webp";
  outputPath: string;
  quality?: number;
  tiles: PageExportCapturedTile[];
};

export type PageExportTileStitcher = (
  request: PageExportTileStitchRequest,
) => Promise<void>;

export function createPageExportTilePlan(
  expected: PageExportRasterSize,
  limits: PageExportRasterLimits = SAFE_PAGE_EXPORT_RASTER_LIMITS,
  requestedOverlap = PAGE_EXPORT_TILE_OVERLAP_PX,
): PageExportTile[] {
  assertPageExportTileTarget(expected, limits);
  const maxCaptureWidth = Math.min(
    expected.width,
    limits.maxSidePx,
    PAGE_EXPORT_CAPTURE_TILE_SIDE_PX,
  );
  const maxCaptureHeight = Math.min(
    expected.height,
    limits.maxSidePx,
    PAGE_EXPORT_CAPTURE_TILE_SIDE_PX,
    Math.floor(limits.maxPixels / maxCaptureWidth),
  );
  if (maxCaptureWidth < 1 || maxCaptureHeight < 1) {
    throw new Error("Page export tile exceeds the capture budget.");
  }
  const columns = createPageExportTileAxis(
    expected.width,
    maxCaptureWidth,
    requestedOverlap,
  );
  const rows = createPageExportTileAxis(
    expected.height,
    maxCaptureHeight,
    requestedOverlap,
  );
  const tiles = rows.flatMap((row) =>
    columns.map((column) => ({
      index: 0,
      captureX: column.captureStart,
      captureY: row.captureStart,
      captureWidth: column.captureSize,
      captureHeight: row.captureSize,
      outputX: column.outputStart,
      outputY: row.outputStart,
      outputWidth: column.outputSize,
      outputHeight: row.outputSize,
      cropLeft: column.cropStart,
      cropTop: row.cropStart,
    })),
  );
  for (const [index, tile] of tiles.entries()) {
    tile.index = index;
    if (
      !validatePageExportRasterSize(
        { width: tile.captureWidth, height: tile.captureHeight },
        limits,
      ).valid
    ) {
      throw new Error("Page export tile exceeds the capture budget.");
    }
  }
  assertContiguousPageExportTiles(tiles, expected);
  return tiles;
}

function assertPageExportTileTarget(
  expected: PageExportRasterSize,
  limits: PageExportRasterLimits,
): void {
  if (
    !Number.isSafeInteger(expected.width) ||
    !Number.isSafeInteger(expected.height) ||
    expected.width < 1 ||
    expected.height < 1 ||
    !Number.isSafeInteger(limits.maxPixels) ||
    !Number.isSafeInteger(limits.maxSidePx) ||
    limits.maxPixels < 1 ||
    limits.maxSidePx < 1
  ) {
    throw new Error("Page export tile dimensions are invalid.");
  }
}

type PageExportTileAxis = {
  captureStart: number;
  captureSize: number;
  outputStart: number;
  outputSize: number;
  cropStart: number;
};

function createPageExportTileAxis(
  totalSize: number,
  maxCaptureSize: number,
  requestedOverlap: number,
): PageExportTileAxis[] {
  if (totalSize <= maxCaptureSize) {
    return [
      {
        captureStart: 0,
        captureSize: totalSize,
        outputStart: 0,
        outputSize: totalSize,
        cropStart: 0,
      },
    ];
  }
  const overlap = Math.min(
    Math.max(0, Math.floor(requestedOverlap)),
    Math.floor((maxCaptureSize - 1) / 2),
  );
  const coreCapacity = maxCaptureSize - overlap * 2;
  if (coreCapacity < 1) {
    throw new Error("Page export tile overlap leaves no capture area.");
  }
  const segments: PageExportTileAxis[] = [];
  for (
    let outputStart = 0;
    outputStart < totalSize;
    outputStart += coreCapacity
  ) {
    const outputSize = Math.min(coreCapacity, totalSize - outputStart);
    const captureStart = Math.max(0, outputStart - overlap);
    const captureEnd = Math.min(totalSize, outputStart + outputSize + overlap);
    segments.push({
      captureStart,
      captureSize: captureEnd - captureStart,
      outputStart,
      outputSize,
      cropStart: outputStart - captureStart,
    });
  }
  return segments;
}

export function buildPageExportTileFfmpegArgs(
  request: PageExportTileStitchRequest,
): string[] {
  const rows = assertContiguousPageExportTiles(request.tiles, request.expected);
  const cropFilters = request.tiles.map(
    (tile) =>
      `[${tile.index}:v]crop=${tile.outputWidth}:${tile.outputHeight}:${tile.cropLeft}:${tile.cropTop}[tile${tile.index}]`,
  );
  const rowFilters = rows.map((row, rowIndex) => {
    const inputs = row.map((tile) => `[tile${tile.index}]`).join("");
    return row.length === 1
      ? `${inputs}null[row${rowIndex}]`
      : `${inputs}hstack=inputs=${row.length}[row${rowIndex}]`;
  });
  const rowInputs = rows.map((_row, index) => `[row${index}]`).join("");
  const stackFilter =
    rows.length === 1
      ? `${rowInputs}null[stacked]`
      : `${rowInputs}vstack=inputs=${rows.length}[stacked]`;
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...request.tiles.flatMap((tile) => ["-i", tile.path]),
    "-filter_complex",
    [...cropFilters, ...rowFilters, stackFilter].join(";"),
    "-map",
    "[stacked]",
    "-frames:v",
    "1",
    ...resolvePageExportEncoderArgs(request.format, request.quality),
    request.outputPath,
  ];
}

export async function stitchPageExportTiles(
  request: PageExportTileStitchRequest,
): Promise<void> {
  const runtimePaths = loadAppRuntimeModule("runtimePaths");
  assertRuntimeFunctions(runtimePaths, "page export runtime paths", [
    "resolveFfmpegPath",
  ]);
  const resolveFfmpegPath = runtimePaths.resolveFfmpegPath as (options: {
    toolsDir: string;
  }) => unknown;
  const ffmpegPath = resolveFfmpegPath({
    toolsDir: getAppPaths().toolsDir,
  });
  if (typeof ffmpegPath !== "string" || ffmpegPath.length < 1) {
    throw new Error("Page export FFmpeg path is invalid.");
  }
  await stitchPageExportTilesWithFfmpeg(request, ffmpegPath);
}

export async function stitchPageExportTilesWithFfmpeg(
  request: PageExportTileStitchRequest,
  ffmpegPath: string,
): Promise<void> {
  await runPageExportFfmpeg(ffmpegPath, buildPageExportTileFfmpegArgs(request));
}

function resolvePageExportEncoderArgs(
  format: PageExportTileStitchRequest["format"],
  quality: number | undefined,
): string[] {
  if (format === "png") {
    return ["-c:v", "png", "-compression_level", "4", "-pred", "mixed"];
  }
  const normalizedQuality = Math.max(1, Math.min(100, quality ?? 90));
  if (format === "jpeg") {
    const qScale = Math.max(
      2,
      Math.min(31, Math.round(31 - (normalizedQuality / 100) * 29)),
    );
    return ["-c:v", "mjpeg", "-q:v", String(qScale), "-pix_fmt", "yuvj444p"];
  }
  return [
    "-c:v",
    "libwebp",
    "-quality",
    String(Math.round(normalizedQuality)),
    "-compression_level",
    "4",
    "-preset",
    "picture",
  ];
}

function assertContiguousPageExportTiles(
  tiles: readonly PageExportTile[],
  expected: PageExportRasterSize,
): PageExportTile[][] {
  if (tiles.length < 1) throw new Error("Page export tile plan is empty.");
  const rows: PageExportTile[][] = [];
  let nextOutputY = 0;
  let tileIndex = 0;
  while (tileIndex < tiles.length) {
    const first = tiles[tileIndex];
    if (!first || first.outputY !== nextOutputY) {
      throw new Error("Page export tile plan is not contiguous.");
    }
    const row: PageExportTile[] = [];
    let nextOutputX = 0;
    while (tileIndex < tiles.length) {
      const tile = tiles[tileIndex];
      if (!tile || tile.outputY !== first.outputY) break;
      if (
        tile.outputHeight !== first.outputHeight ||
        !isValidPageExportTile(
          tile,
          tileIndex,
          nextOutputX,
          nextOutputY,
          expected,
        )
      ) {
        throw new Error("Page export tile plan is not contiguous.");
      }
      row.push(tile);
      nextOutputX += tile.outputWidth;
      tileIndex += 1;
    }
    if (nextOutputX !== expected.width) {
      throw new Error("Page export tile plan does not cover the output width.");
    }
    rows.push(row);
    nextOutputY += first.outputHeight;
  }
  if (nextOutputY !== expected.height) {
    throw new Error("Page export tile plan does not cover the output height.");
  }
  return rows;
}

function isValidPageExportTile(
  tile: PageExportTile,
  index: number,
  nextOutputX: number,
  nextOutputY: number,
  expected: PageExportRasterSize,
): boolean {
  return (
    tile.index === index &&
    isValidPageExportTileAxis(
      tile.captureX,
      tile.captureWidth,
      tile.outputX,
      tile.outputWidth,
      tile.cropLeft,
      nextOutputX,
      expected.width,
    ) &&
    isValidPageExportTileAxis(
      tile.captureY,
      tile.captureHeight,
      tile.outputY,
      tile.outputHeight,
      tile.cropTop,
      nextOutputY,
      expected.height,
    )
  );
}

function isValidPageExportTileAxis(
  captureStart: number,
  captureSize: number,
  outputStart: number,
  outputSize: number,
  cropStart: number,
  nextOutputStart: number,
  expectedSize: number,
): boolean {
  return (
    outputStart === nextOutputStart &&
    outputSize >= 1 &&
    captureStart >= 0 &&
    cropStart >= 0 &&
    captureStart + cropStart === outputStart &&
    captureStart + captureSize <= expectedSize &&
    outputStart + outputSize <= expectedSize &&
    cropStart + outputSize <= captureSize
  );
}

function runPageExportFfmpeg(
  executable: string,
  args: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let errorText = "";
    let spawnError: Error | null = null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PAGE_EXPORT_STITCH_TIMEOUT_MS);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (errorText.length < MAX_FFMPEG_ERROR_CHARS) {
        errorText = `${errorText}${chunk}`.slice(0, MAX_FFMPEG_ERROR_CHARS);
      }
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error("Page export tile stitching timed out."));
        return;
      }
      if (spawnError) {
        reject(spawnError);
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `Page export tile stitching failed (${code ?? "unknown"}): ${errorText.trim()}`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}
