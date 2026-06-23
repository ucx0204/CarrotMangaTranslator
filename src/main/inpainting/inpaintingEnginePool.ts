import type { AppPaths } from "../appPaths";
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

export async function acquireInpaintingEngine(options: {
  appPaths: AppPaths;
  model: InpaintingModel;
  fluxBackend?: FluxBackend;
  koharuBackend?: KoharuInpaintingBackend;
  signal?: AbortSignal;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
}): Promise<InpaintingEngineLease> {
  if (options.model === "flux-klein") {
    return acquireFluxInpaintingEngine({
      appPaths: options.appPaths,
      fluxBackend: options.fluxBackend,
      signal: options.signal,
      onProgress: options.onProgress,
    });
  }

  return acquireKoharuInpaintingEngine({
    appPaths: options.appPaths,
    model: options.model,
    backend: options.koharuBackend ?? "auto",
    signal: options.signal,
    onProgress: options.onProgress,
  });
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
