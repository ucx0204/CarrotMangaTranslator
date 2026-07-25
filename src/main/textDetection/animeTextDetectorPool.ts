import { AbortableExclusiveGate } from "../runtimeSupport/abortableExclusiveGate";
import { LeasedIdleResourcePool } from "../runtimeSupport/leasedIdleResource";
import { prepareAnimeTextWorkerLaunch } from "./animeTextAssets";
import { AnimeTextWorker } from "./animeTextWorker";
import { logAnimeTextError, logAnimeTextInfo } from "./animeTextLogger";
import type { RuntimeAssetProgress } from "../runtimeSupport/modelDownloads";

const DETECTOR_IDLE_TTL_MS = 20 * 1000;
const detectorGate = new AbortableExclusiveGate();

const detectorPool = new LeasedIdleResourcePool<AnimeTextWorker>({
  idleTtlMs: DETECTOR_IDLE_TTL_MS,
  isReusable: (worker) => worker.isHealthy(),
  dispose: disposeWorker,
});

export async function acquireAnimeTextDetector(options: {
  dataRoot: string;
  signal?: AbortSignal;
  onProgress?: (progress: RuntimeAssetProgress) => void;
}): Promise<{
  detector: AnimeTextWorker;
  release: () => void;
}> {
  const exclusiveLease = await detectorGate.acquire(options.signal);
  try {
    const detectorLease = await detectorPool.acquire(
      options.dataRoot,
      async () => {
        const launch = await prepareAnimeTextWorkerLaunch(options);
        return new AnimeTextWorker(launch);
      },
    );
    return buildExclusiveDetectorLease(detectorLease, exclusiveLease);
  } catch (error) {
    exclusiveLease.release();
    throw error;
  }
}

export function disposeCachedAnimeTextDetector(
  reason: string,
): Promise<boolean> {
  return detectorPool.dispose(reason);
}

async function disposeWorker(
  worker: AnimeTextWorker,
  reason: string,
): Promise<void> {
  try {
    await worker.dispose();
    logAnimeTextInfo("anime-text-yolo worker disposed", { reason });
  } catch (error) {
    logAnimeTextError("Failed to dispose anime-text-yolo worker", {
      reason,
      error,
    });
  }
}

function buildExclusiveDetectorLease(
  detectorLease: {
    resource: AnimeTextWorker;
    release: () => void;
  },
  exclusiveLease: { release: () => void },
): {
  detector: AnimeTextWorker;
  release: () => void;
} {
  let released = false;
  return {
    detector: detectorLease.resource,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      detectorLease.release();
      exclusiveLease.release();
    },
  };
}
