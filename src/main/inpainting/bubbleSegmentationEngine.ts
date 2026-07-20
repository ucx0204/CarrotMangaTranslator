import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { safeCleanup } from "../safeCleanup";
import { BubbleSegmentationWorker } from "./bubbleSegmentationWorker";
import { readGeneratedBitmap, writePngFromBitmap } from "./imageRaster";
import type { KoharuWorkerLaunchSpec } from "./koharuWorkerTypes";

export type BubbleSegmentationEngine = {
  backend: string;
  dispose: () => Promise<void>;
  isHealthy: () => boolean;
  segment: (
    bitmap: Buffer,
    width: number,
    height: number,
    options?: { signal?: AbortSignal },
  ) => Promise<Uint8Array>;
};

export function createBubbleSegmentationEngine(options: {
  launch: KoharuWorkerLaunchSpec;
  runRootDir: string;
}): BubbleSegmentationEngine {
  const worker = new BubbleSegmentationWorker(options.launch);
  return {
    backend: options.launch.backend,
    isHealthy: () => worker.isHealthy(),
    async segment(bitmap, width, height, runOptions = {}) {
      return runBubbleSegmentation({
        bitmap,
        height,
        runRootDir: options.runRootDir,
        signal: runOptions.signal,
        width,
        worker,
      });
    },
    dispose: () => worker.dispose(),
  };
}

async function runBubbleSegmentation({
  bitmap,
  height,
  runRootDir,
  signal,
  width,
  worker,
}: {
  bitmap: Buffer;
  height: number;
  runRootDir: string;
  signal?: AbortSignal;
  width: number;
  worker: BubbleSegmentationWorker;
}): Promise<Uint8Array> {
  const runDir = join(
    runRootDir,
    `bubble-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(runDir, { recursive: true });
  try {
    const inputPath = join(runDir, "input.png");
    const outputPath = join(runDir, "bubble-mask.png");
    await writePngFromBitmap(inputPath, bitmap, width, height, {
      width,
      height,
    });
    await worker.segment({ input: inputPath, output: outputPath }, signal);
    const generated = await readGeneratedBitmap(outputPath, width, height);
    const mask = new Uint8Array(width * height);
    for (let index = 0; index < mask.length; index += 1) {
      mask[index] = generated[index * 4] ?? 0;
    }
    return mask;
  } finally {
    await safeCleanup("remove bubble segmentation run directory", () =>
      rm(runDir, { recursive: true, force: true }),
    );
  }
}
