import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  FluxWorkerBackend,
  FluxWorkerLaunchSpec,
} from "../fluxWorkerTypes";
import { logInpaintingRuntimeInfo } from "../inpaintingRuntimeLogger";
import { FLUX_CUDA_RUNTIME_DIR } from "./constants";
import type { FluxAssetProgress, FluxRuntimeBackend } from "./types";
import { ensureFluxCudaRuntime } from "./cudaRuntime";
import { ensureManagedFluxRunner } from "./runner";
import { ensureFluxZludaSupportRuntime } from "./zludaRuntime";
import { ensureFluxPythonRuntime } from "./pythonRuntime";

type EnsureFluxWorkerLaunchOptions = {
  runtimeDir: string;
  modelDir: string;
  backend: FluxRuntimeBackend;
  nvidiaComputeCapability?: number | null;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
};

async function ensureMgtFluxKleinRuntime(options: {
  runtimeDir: string;
  nvidiaComputeCapability?: number | null;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  await mkdir(options.runtimeDir, { recursive: true });
  const runtimePath = await ensureManagedFluxRunner(options);
  await ensureFluxCudaRuntime(options);
  const runtimeLabel = formatRuntimePathLabel(runtimePath);
  options.onProgress?.({
    progressText: "Flux 런타임 캐시 사용",
    detail: runtimeLabel,
    progressMode: "log-only",
    installLogLine: `MGT Flux Klein 런타임을 사용합니다: ${runtimeLabel}`,
  });
  return runtimePath;
}

export async function ensureFluxWorkerLaunch(
  options: EnsureFluxWorkerLaunchOptions,
): Promise<FluxWorkerLaunchSpec> {
  const backend = resolveFluxWorkerBackend(options.backend);
  if (backend === "metal-native") {
    return ensureFluxMetalWorkerLaunch(options);
  }
  if (backend === "cuda-native") {
    const runtimePath = await ensureMgtFluxKleinRuntime(options);
    const cudaRuntimeDir = join(options.runtimeDir, FLUX_CUDA_RUNTIME_DIR);
    logFluxRuntimeSelected({
      backend,
      nvidiaComputeCapability: options.nvidiaComputeCapability,
      runtimePath,
      cudaRuntimeDir,
    });
    return {
      backend,
      executable: runtimePath,
      runtimePath,
      label: "Flux Klein CUDA",
      args: ["--cuda-runtime-dir", cudaRuntimeDir],
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
    logFluxRuntimeSelected({
      backend,
      nvidiaComputeCapability: options.nvidiaComputeCapability,
      runtimePath,
      cudaRuntimeDir,
      zludaRuntimeRoot,
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
    const launch = await ensureFluxPythonRuntime({ ...options, backend });
    logFluxRuntimeSelected({
      backend,
      nvidiaComputeCapability: options.nvidiaComputeCapability,
      runtimePath: launch.runtimePath,
      executable: launch.executable,
    });
    return launch;
  }
  throw new Error(`지원하지 않는 Flux 런타임입니다: ${backend}`);
}

async function ensureFluxMetalWorkerLaunch(
  options: EnsureFluxWorkerLaunchOptions,
): Promise<FluxWorkerLaunchSpec> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(
      "Flux Metal 런타임은 Apple Silicon(macOS arm64)에서만 사용할 수 있습니다.",
    );
  }
  await mkdir(options.runtimeDir, { recursive: true });
  const runtimePath = await ensureManagedFluxRunner(options);
  logFluxRuntimeSelected({
    backend: "metal-native",
    nvidiaComputeCapability: null,
    runtimePath,
  });
  return {
    backend: "metal-native",
    executable: runtimePath,
    runtimePath,
    label: "Flux Klein Metal",
    args: ["--require-metal"],
  };
}

function logFluxRuntimeSelected(detail: {
  backend: FluxWorkerBackend;
  cudaRuntimeDir?: string;
  executable?: string;
  nvidiaComputeCapability?: number | null;
  runtimePath: string;
  zludaRuntimeRoot?: string;
}): void {
  logInpaintingRuntimeInfo("Flux runtime selected", detail);
}

export function resolveFluxWorkerBackend(
  backend: FluxRuntimeBackend,
): FluxWorkerBackend {
  if (backend === "python-cpu") {
    return backend;
  }
  if (backend === "metal-native") {
    return backend;
  }
  if (backend === "zluda-native" || backend === "python-rocm") {
    return "zluda-native";
  }
  return "cuda-native";
}

function formatRuntimePathLabel(runtimePath: string): string {
  return `${basename(dirname(runtimePath))}/${basename(runtimePath)}`;
}
