import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { safeCleanup } from "../safeCleanup";
import { readGeneratedBitmap, writePngFromBitmap } from "./imageRaster";
import type { BubbleQualityRefinerEngine } from "./bubbleQualityRefiner";
import type { BubbleQualityWorkerLaunch } from "./bubbleQualityRuntime";
import { BubbleQualityWorker } from "./bubbleQualityWorker";

export function createBubbleQualityRefinerEngine(options: {
  launch: BubbleQualityWorkerLaunch;
  runRootDir: string;
}): BubbleQualityRefinerEngine {
  const worker = new BubbleQualityWorker(options.launch);
  return {
    backend: options.launch.backend,
    model: options.launch.model,
    isHealthy: () => worker.isHealthy(),
    async refine(bitmap, width, height, hints, runOptions = {}) {
      const runDir = join(
        options.runRootDir,
        `quality-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      );
      await mkdir(runDir, { recursive: true });
      try {
        const inputPath = join(runDir, "input.png");
        const outputPath = join(runDir, "recovered-mask.png");
        await writePngFromBitmap(inputPath, bitmap, width, height, {
          width,
          height,
        });
        await worker.refine(
          { input: inputPath, output: outputPath, hints: hints.slice(0, 254) },
          runOptions.signal,
        );
        const generated = await readGeneratedBitmap(outputPath, width, height);
        const mask = new Uint8Array(width * height);
        for (let index = 0; index < mask.length; index += 1) {
          mask[index] = generated[index * 4] ?? 0;
        }
        return mask;
      } finally {
        await safeCleanup("remove bubble quality run directory", () =>
          rm(runDir, { recursive: true, force: true }),
        );
      }
    },
    dispose: () => worker.dispose(),
  };
}
