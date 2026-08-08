import { mkdir } from "node:fs/promises";
import type { FluxAssetProgress, FluxPythonBackend } from "./types";
import {
  resolvePythonBuildPackages,
  resolvePythonFluxPackages,
  resolvePythonRuntimeInstallBatches,
} from "./manifests";
import {
  ensureFluxPythonWorker,
  findFluxPythonWorkerSource,
  resolveCurrentFluxPythonRuntime,
  resolveFluxPythonRuntimeLayout,
  resolveFluxPythonWorkerFile,
} from "./pythonRuntimeLayout";
import { sha256FileSync } from "../../runtimeSupport/fileProbe";
import type { FluxWorkerLaunchSpec } from "../fluxWorkerTypes";
import {
  ensureMissingFluxPythonRuntime,
  type FluxPythonExpectedMarker,
} from "./pythonRuntimeInstaller";
import { buildFluxPythonLaunchSpec } from "./pythonRuntimeLaunchSpec";
import { resolveFluxPythonIntegrityId } from "./pythonIntegrity";

export async function ensureFluxPythonRuntime(options: {
  runtimeDir: string;
  modelDir: string;
  backend: FluxPythonBackend;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<FluxWorkerLaunchSpec> {
  await mkdir(options.runtimeDir, { recursive: true });
  const layout = resolveFluxPythonRuntimeLayout(
    options.runtimeDir,
    options.backend,
  );
  const { runtimeDir, venvPythonPath, packageDir, workerPath, markerPath } =
    layout;
  const runtimeInstallBatches = resolvePythonRuntimeInstallBatches(
    options.backend,
  );
  const buildPackages = resolvePythonBuildPackages(options.backend);
  const extraPackages = resolvePythonFluxPackages(options.backend);
  const workerFile = resolveFluxPythonWorkerFile(options.backend);
  const workerSource = findFluxPythonWorkerSource(workerFile);
  const workerHash = workerSource ? sha256FileSync(workerSource) : "missing";
  const expectedMarker: FluxPythonExpectedMarker = {
    backend: options.backend,
    integrityId: resolveFluxPythonIntegrityId(options.backend),
    runtimeInstallBatches: runtimeInstallBatches.map((batch) => ({
      id: batch.id,
      pipArgs: batch.pipArgs,
    })),
    buildPackages,
    packages: extraPackages,
    worker: workerFile,
    workerHash,
  };

  let pythonRuntime = await resolveCurrentFluxPythonRuntime({
    runtimeDir,
    venvPythonPath,
    packageDir,
    markerPath,
    expectedMarker,
  });

  if (!pythonRuntime) {
    pythonRuntime = await ensureMissingFluxPythonRuntime({
      backend: options.backend,
      buildPackages,
      expectedMarker,
      extraPackages,
      layout,
      onProgress: options.onProgress,
      runtimeInstallBatches,
      signal: options.signal,
      workerFile,
    });
  } else {
    await ensureFluxPythonWorker(runtimeDir, workerFile);
  }
  if (!pythonRuntime) {
    throw new Error("Flux Python 런타임 준비 상태를 확인하지 못했습니다.");
  }

  return buildFluxPythonLaunchSpec({
    backend: options.backend,
    pythonRuntime,
    modelDir: options.modelDir,
    signal: options.signal,
    onProgress: options.onProgress,
    workerPath,
  });
}
