import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FluxWorkerBackend, FluxWorkerLaunchSpec } from "../fluxWorker";
import type { FluxAssetProgress, FluxRuntimeBackend } from "./types";
import { ensureFluxCudaRuntime, ensureManagedFluxRunner } from "./cudaRuntime";
import { ensureFluxZludaSupportRuntime } from "./zludaRuntime";
import { ensureFluxPythonRuntime } from "./pythonRuntime";

export async function ensureMgtFluxKleinRuntime(options: {
  runtimeDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  await mkdir(options.runtimeDir, { recursive: true });
  const runtimePath = await ensureManagedFluxRunner(options);
  await ensureFluxCudaRuntime(options);
  options.onProgress?.({
    progressText: "Flux 런타임 캐시 사용",
    detail: basename(runtimePath),
    progressMode: "log-only",
    installLogLine: `MGT Flux Klein 런타임을 사용합니다: ${basename(runtimePath)}`,
  });
  return runtimePath;
}

export async function ensureFluxWorkerLaunch(options: {
  runtimeDir: string;
  modelDir: string;
  backend: FluxRuntimeBackend;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<FluxWorkerLaunchSpec> {
  const backend = resolveFluxWorkerBackend(options.backend);
  if (backend === "cuda-native") {
    const runtimePath = await ensureMgtFluxKleinRuntime(options);
    return {
      backend,
      executable: runtimePath,
      runtimePath,
      label: "Flux Klein CUDA",
      args: [],
    };
  }
  if (backend === "zluda-native") {
    await mkdir(options.runtimeDir, { recursive: true });
    const runtimePath = await ensureManagedFluxRunner(options);
    const cudaRuntimeDir = await ensureFluxZludaSupportRuntime(options);
    const zludaRuntimeRoot = join(options.runtimeDir, "koharu-zluda");
    options.onProgress?.({
      progressText: "Flux ZLUDA 런타임 준비 중",
      detail: "Koharu/Candle ZLUDA",
      progressMode: "log-only",
      installLogLine:
        "AMD GPU에서는 NVIDIA와 같은 Flux Klein 실행기를 ZLUDA/HIP 경로로 실행하고, 필요한 CUDA 보조 DLL만 함께 준비합니다.",
    });
    return {
      backend,
      executable: runtimePath,
      runtimePath,
      label: "Flux Klein ZLUDA",
      args: [
        "--require-zluda",
        "--zluda-runtime-root",
        zludaRuntimeRoot,
        "--cuda-runtime-dir",
        cudaRuntimeDir,
      ],
      env: {
        KOHARU_DATA_ROOT: zludaRuntimeRoot,
      },
    };
  }
  if (backend === "python-rocm" || backend === "python-cpu") {
    return ensureFluxPythonRuntime({ ...options, backend });
  }
  throw new Error(`지원하지 않는 Flux 런타임입니다: ${backend}`);
}

function resolveFluxWorkerBackend(
  backend: FluxRuntimeBackend,
): FluxWorkerBackend {
  if (backend === "python-cpu") {
    return backend;
  }
  if (backend === "zluda-native" || backend === "python-rocm") {
    return "zluda-native";
  }
  return "cuda-native";
}
