import type {
  FluxWorkerBackend,
  FluxWorkerLaunchSpec,
} from "../fluxWorkerTypes";
import {
  logInpaintingRuntimeInfo,
  logInpaintingRuntimeWarn,
} from "../inpaintingRuntimeLogger";
import type { FluxAssetProgress, FluxRuntimeBackend } from "./types";
import { ensureManagedFluxCpuRunner } from "./cpuRunner";
import { ensureManagedFluxRunner } from "./runner";
import { ensureFluxPythonRuntime } from "./pythonRuntime";
import { prepareNativeInferenceLaunch } from "../../runtimeSupport/nativeInferenceLaunch";
import type { NativeInferenceBackend } from "../../runtimeSupport/nativeInferencePlan";

const NATIVE_BACKENDS: Partial<
  Record<FluxWorkerBackend, { backend: NativeInferenceBackend; label: string }>
> = {
  "cpu-native": {
    backend: "cpu",
    label: "Flux Klein CPU (매우 느린 호환 모드)",
  },
  "cuda-native": { backend: "cuda", label: "Flux Klein CUDA" },
  "rocm-native": { backend: "rocm", label: "Flux Klein ROCm" },
  "vulkan-native": { backend: "vulkan", label: "Flux Klein Vulkan" },
  "metal-native": { backend: "metal", label: "Flux Klein Metal" },
};

type EnsureFluxWorkerLaunchOptions = {
  runtimeDir: string;
  modelDir: string;
  backend: FluxRuntimeBackend;
  computeGpuIndex?: number;
  nvidiaComputeCapability?: number | null;
  sm75Fp16Enabled?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
};

export async function ensureFluxWorkerLaunch(
  options: EnsureFluxWorkerLaunchOptions,
): Promise<FluxWorkerLaunchSpec> {
  const backend = resolveFluxWorkerBackend(options.backend);
  if (
    backend === "python-cpu" ||
    (backend === "cpu-native" && shouldUseLegacyFluxDiffusersCpu())
  ) {
    logInpaintingRuntimeWarn(
      "Legacy Flux Diffusers CPU diagnostic override enabled",
      {
        environmentVariable: "MGT_FLUX_LEGACY_DIFFUSERS_CPU",
      },
    );
    return ensureFluxPythonRuntime({ ...options, backend: "python-cpu" });
  }
  if (
    backend === "metal-native" &&
    (process.platform !== "darwin" || process.arch !== "arm64")
  ) {
    throw new Error(
      "Flux Metal 런타임은 Apple Silicon(macOS arm64)에서만 사용할 수 있습니다.",
    );
  }
  const executable = await ensureFluxExecutable(options, backend);
  const selection = NATIVE_BACKENDS[backend];
  if (!selection) throw new Error(`Unsupported native backend: ${backend}`);
  const native = await prepareNativeInferenceLaunch({
    ...options,
    executable,
    engine: "diffusion",
    backend: selection.backend,
  });
  const label = selection.label;
  options.onProgress?.({
    progressText: "Flux 네이티브 런타임 준비 완료",
    detail: label,
    progressMode: "log-only",
    installLogLine: label + " · Koharu 0.83.5 / stable-diffusion.cpp",
  });
  logInpaintingRuntimeInfo("Flux runtime selected", {
    backend,
    runtimePath: native.executable,
    nativeManifest: native.manifest,
  });
  return {
    backend,
    executable: native.executable,
    runtimePath: native.executable,
    label,
    args: [
      "--native-runtime",
      native.manifest,
      ...(backend === "metal-native" ? ["--require-metal"] : []),
    ],
    env: native.env,
  };
}

export function resolveFluxWorkerBackend(
  backend: FluxRuntimeBackend,
): FluxWorkerBackend {
  if (
    backend === "python-cpu" ||
    backend === "cpu-native" ||
    backend === "metal-native" ||
    backend === "vulkan-native"
  )
    return backend;
  if (
    backend === "rocm-native" ||
    backend === "zluda-native" ||
    backend === "python-rocm"
  )
    return "rocm-native";
  return "cuda-native";
}

export function shouldUseLegacyFluxDiffusersCpu(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return /^(1|true|yes|on)$/i.test(
    String(env.MGT_FLUX_LEGACY_DIFFUSERS_CPU ?? "").trim(),
  );
}

async function ensureFluxExecutable(
  options: EnsureFluxWorkerLaunchOptions,
  backend: FluxWorkerBackend,
): Promise<string | undefined> {
  if (backend === "vulkan-native") return undefined;
  if (backend === "cpu-native" && process.platform === "win32")
    return ensureManagedFluxCpuRunner(options);
  return ensureManagedFluxRunner(options);
}
