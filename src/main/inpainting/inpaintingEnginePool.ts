import type { AppPaths } from "../appPaths";
import { totalmem } from "node:os";
import type {
  FluxBackend,
  InpaintingModel,
  KoharuInpaintingBackend,
} from "../../shared/inpaintingSettingsTypes";
import type {
  InpaintingEngine,
  InpaintingRuntimeProgress,
} from "./inpaintingEngine";
import {
  acquireFluxInpaintingEngine,
  disposeCachedFluxInpaintingEngine,
} from "./fluxEnginePool";
import {
  acquireKoharuInpaintingEngine,
  disposeCachedKoharuInpaintingEngine,
} from "./koharuEnginePool";

export type InpaintingEngineLease = {
  engine: InpaintingEngine;
  release: () => void;
};

export const FLUX_RECOMMENDED_UNIFIED_MEMORY_MB = 16 * 1024;

export async function acquireInpaintingEngine(options: {
  appPaths: AppPaths;
  model: InpaintingModel;
  fluxBackend?: FluxBackend;
  koharuBackend?: KoharuInpaintingBackend;
  allowUnsafeLowMemoryFlux?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
}): Promise<InpaintingEngineLease> {
  if (options.model === "flux-klein") {
    assertFluxMemoryPolicy({
      backend:
        options.fluxBackend ??
        (process.platform === "darwin" ? "metal-native" : "cuda-native"),
      unifiedMemoryMb: Math.floor(totalmem() / 1024 / 1024),
      allowUnsafeLowMemoryFlux: options.allowUnsafeLowMemoryFlux ?? false,
    });
    await disposeCachedKoharuInpaintingEngine("switch-to-flux");
    return acquireFluxInpaintingEngine({
      appPaths: options.appPaths,
      fluxBackend: options.fluxBackend,
      signal: options.signal,
      onProgress: options.onProgress,
    });
  }

  await disposeCachedFluxInpaintingEngine("switch-to-koharu");
  return acquireKoharuInpaintingEngine({
    appPaths: options.appPaths,
    model: options.model,
    backend: options.koharuBackend ?? "auto",
    signal: options.signal,
    onProgress: options.onProgress,
  });
}

export function assertFluxMemoryPolicy(options: {
  backend: FluxBackend;
  unifiedMemoryMb: number;
  allowUnsafeLowMemoryFlux: boolean;
}): void {
  if (
    options.backend !== "metal-native" ||
    options.unifiedMemoryMb >= FLUX_RECOMMENDED_UNIFIED_MEMORY_MB ||
    options.allowUnsafeLowMemoryFlux
  ) {
    return;
  }
  throw new Error(
    `Flux Klein Metal은 통합 메모리 16GB 이상을 권장합니다. 현재 ${Math.max(0, Math.round(options.unifiedMemoryMb / 1024))}GB로 감지되었습니다. macOS 메모리 위험 경고를 확인하고 명시적으로 허용한 뒤 다시 시도하세요.`,
  );
}

export async function disposeCachedInpaintingEngines(
  reason: string,
): Promise<boolean> {
  const [fluxDisposed, koharuDisposed] = await Promise.all([
    disposeCachedFluxInpaintingEngine(reason),
    disposeCachedKoharuInpaintingEngine(reason),
  ]);
  return fluxDisposed || koharuDisposed;
}
