import { join } from "node:path";
import type { AppPaths } from "../appPaths";
import type { KoharuInpaintingBackend } from "../../shared/inpaintingSettingsTypes";
import { ensureBubbleSegmentationWorkerLaunch } from "./bubbleSegmentationAssets";
import {
  createBubbleSegmentationEngine,
  type BubbleSegmentationEngine,
} from "./bubbleSegmentationEngine";
import type { InpaintingRuntimeProgress } from "./inpaintingEngine";
import { resolveKoharuBackendCandidates } from "./koharuEnginePool";
import {
  logInpaintingRuntimeError,
  logInpaintingRuntimeInfo,
  logInpaintingRuntimeWarn,
} from "./inpaintingRuntimeLogger";
import { LeasedIdleResourcePool } from "./leasedIdleResource";

const BUBBLE_SEGMENTATION_IDLE_TTL_MS = 30 * 1000;

export type BubbleSegmentationEngineLease = {
  engine: BubbleSegmentationEngine;
  release: () => void;
};

const enginePool = new LeasedIdleResourcePool<BubbleSegmentationEngine>({
  idleTtlMs: BUBBLE_SEGMENTATION_IDLE_TTL_MS,
  isReusable: (engine) => engine.isHealthy(),
  dispose: async (engine, reason) => {
    await engine.dispose();
    logInpaintingRuntimeInfo("Bubble segmentation engine disposed", { reason });
  },
});

export async function acquireBubbleSegmentationEngine(options: {
  appPaths: AppPaths;
  backend: KoharuInpaintingBackend;
  signal?: AbortSignal;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
}): Promise<BubbleSegmentationEngineLease> {
  const paths = resolvePaths(options.appPaths);
  const candidates = await resolveKoharuBackendCandidates(options.backend);
  const errors: string[] = [];
  for (const backend of candidates) {
    const key = `${backend}\n${paths.runtimeDir}\n${paths.modelDir}`;
    try {
      const lease = await enginePool.acquire(key, async () => {
        const launch = await ensureBubbleSegmentationWorkerLaunch({
          ...paths,
          backend,
          signal: options.signal,
          onProgress: options.onProgress,
        });
        let engine: BubbleSegmentationEngine | null = null;
        try {
          engine = createBubbleSegmentationEngine({
            launch,
            runRootDir: paths.runRootDir,
          });
          await smokeTest(engine, options.signal);
          return engine;
        } catch (error) {
          await engine?.dispose().catch((disposeError) => {
            logInpaintingRuntimeError(
              "Failed to dispose failed bubble segmentation engine",
              { backend, disposeError },
            );
          });
          throw error;
        }
      });
      return { engine: lease.resource, release: lease.release };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${backend}: ${message}`);
      logInpaintingRuntimeWarn("Bubble segmentation backend failed", {
        backend,
        error,
      });
    }
  }
  throw new Error(
    `말풍선 정밀 감지 런타임을 준비하지 못했습니다. ${errors.join("\n")}`,
  );
}

export async function disposeCachedBubbleSegmentationEngine(
  reason: string,
): Promise<boolean> {
  return enginePool.dispose(reason);
}

function resolvePaths(appPaths: AppPaths): {
  cudaRuntimeDir: string;
  modelDir: string;
  runRootDir: string;
  runtimeDir: string;
} {
  return {
    cudaRuntimeDir: join(
      appPaths.dataRoot,
      "models",
      "inpainting",
      "mgt-flux-klein-runtime",
    ),
    modelDir: join(
      appPaths.dataRoot,
      "models",
      "bubble-segmentation",
      "speech-bubble-segmentation",
    ),
    runRootDir: join(
      appPaths.dataRoot,
      "tmp",
      "runtime",
      "bubble-segmentation",
    ),
    runtimeDir: join(appPaths.dataRoot, "runtime", "bubble-segmentation"),
  };
}

async function smokeTest(
  engine: BubbleSegmentationEngine,
  signal?: AbortSignal,
): Promise<void> {
  const width = 96;
  const height = 96;
  const bitmap = Buffer.alloc(width * height * 4, 255);
  await engine.segment(bitmap, width, height, { signal });
}
