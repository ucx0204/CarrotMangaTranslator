import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { safeCleanup } from "../safeCleanup";
import { KoharuWorker } from "./koharuWorker";
import {
  readGeneratedBitmap,
  writePngFromBitmap,
  writePngFromMask,
} from "./imageRaster";
import type { PixelRect } from "./maskGeometry";

type KoharuInpaintRunOptions = {
  signal?: AbortSignal;
  maxPixels?: number;
  bubbleMask?: Uint8Array;
};

type KoharuInpaintRunnerArgs = {
  bitmap: Buffer;
  getWorker: () => KoharuWorker;
  height: number;
  mask: Uint8Array;
  runOptions: KoharuInpaintRunOptions;
  runRootDir: string;
  width: number;
  windows: PixelRect[];
};

export async function runKoharuInpaint({
  bitmap,
  getWorker,
  height,
  mask,
  runOptions,
  runRootDir,
  width,
  windows,
}: KoharuInpaintRunnerArgs): Promise<void> {
  const runDir = join(
    runRootDir,
    `koharu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(runDir, { recursive: true });

  try {
    const paths = {
      inputPath: join(runDir, "input.png"),
      maskPath: join(runDir, "mask.png"),
      bubblePath: join(runDir, "bubble.png"),
      outputPath: join(runDir, "output.png"),
    };
    const processSize = { width, height };
    await writePngFromBitmap(
      paths.inputPath,
      bitmap,
      width,
      height,
      processSize,
    );
    await writePngFromMask(paths.maskPath, mask, width, height, processSize);
    await writePngFromMask(
      paths.bubblePath,
      runOptions.bubbleMask ?? new Uint8Array(width * height),
      width,
      height,
      processSize,
    );

    await getWorker().inpaint(
      {
        input: paths.inputPath,
        mask: paths.maskPath,
        bubbleMask: paths.bubblePath,
        output: paths.outputPath,
        windows: windows.map((rect) => [
          rect.x,
          rect.y,
          rect.x + rect.w,
          rect.y + rect.h,
        ]),
        maxPixels: runOptions.maxPixels,
      },
      runOptions.signal,
    );

    const generated = await readGeneratedBitmap(
      paths.outputPath,
      width,
      height,
    );
    generated.copy(bitmap, 0, 0, width * height * 4);
  } finally {
    await cleanupKoharuRunDir(runDir);
  }
}

async function cleanupKoharuRunDir(runDir: string): Promise<void> {
  if (process.env.MGT_KEEP_KOHARU_DEBUG === "1") {
    return;
  }
  await safeCleanup("remove Koharu inpainting run directory", () =>
    rm(runDir, { recursive: true, force: true }),
  );
}
