import { join } from "node:path";
import type { KoharuInpaintingBackend } from "../../shared/inpaintingSettingsTypes";
import type { AppPaths } from "../appPaths";
import { createBubbleQualityRefinerEngine } from "./bubbleQualityRefinerEngine";
import type {
  BubbleQualityRefinerEngine,
  BubbleQualityRefinerLease,
} from "./bubbleQualityRefiner";
import {
  ensureBubbleQualityWorkerLaunch,
  type BubbleQualityModel,
} from "./bubbleQualityRuntime";
import type { InpaintingRuntimeProgress } from "./inpaintingEngine";
import { logInpaintingRuntimeInfo } from "./inpaintingRuntimeLogger";
import { LeasedIdleResourcePool } from "./leasedIdleResource";

const QUALITY_REFINER_IDLE_TTL_MS = 30 * 1000;

const refinerPool = new LeasedIdleResourcePool<BubbleQualityRefinerEngine>({
  idleTtlMs: QUALITY_REFINER_IDLE_TTL_MS,
  isReusable: (refiner) => refiner.isHealthy(),
  dispose: async (refiner, reason) => {
    await refiner.dispose();
    logInpaintingRuntimeInfo("Bubble quality refiner disposed", { reason });
  },
});

export async function acquireBubbleQualityRefiner(options: {
  appPaths: AppPaths;
  backend: Exclude<KoharuInpaintingBackend, "auto">;
  requestedModel: BubbleQualityModel;
  signal?: AbortSignal;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
}): Promise<BubbleQualityRefinerLease> {
  const key = [
    options.backend,
    options.requestedModel,
    options.appPaths.dataRoot,
  ].join("\n");
  const lease = await refinerPool.acquire(key, async () => {
    const launch = await ensureBubbleQualityWorkerLaunch({
      backend: options.backend,
      dataRoot: options.appPaths.dataRoot,
      requestedModel: options.requestedModel,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    const engine = createBubbleQualityRefinerEngine({
      launch,
      runRootDir: join(
        options.appPaths.dataRoot,
        "tmp",
        "runtime",
        "bubble-quality",
      ),
    });
    try {
      await smokeTest(engine, options.signal);
      return engine;
    } catch (error) {
      await engine.dispose();
      throw error;
    }
  });
  return { refiner: lease.resource, release: lease.release };
}

async function smokeTest(
  refiner: BubbleQualityRefinerEngine,
  signal?: AbortSignal,
): Promise<void> {
  const width = 64;
  const height = 64;
  await refiner.refine(
    Buffer.alloc(width * height * 4, 255),
    width,
    height,
    [{ blockId: "smoke", rect: { x: 24, y: 20, w: 16, h: 24 } }],
    { signal },
  );
}
