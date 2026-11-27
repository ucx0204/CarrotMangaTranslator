import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveNativeRocmGpuSupport } from "../settings/fluxZludaSupport";
import { release } from "node:os";
import type { FluxBackend } from "../../shared/inpaintingSettingsTypes";
import { normalizeNvidiaGpuUuid } from "../../shared/gpuSettings";
import type { AppPaths } from "../appPaths";
import { detectBestGpuInfo, queryNvidiaGpuInfo } from "../gpuInfo";
import { sha256FileSync } from "../runtimeSupport/fileProbe";
import { LeasedIdleResourcePool } from "../runtimeSupport/leasedIdleResource";
import { releaseModelResource } from "../runtimeSupport/modelCleanupBarrier";
import { prepareNativeInferenceLaunch } from "../runtimeSupport/nativeInferenceLaunch";
import { runFluxInpaint } from "./fluxEngineRunner";
import type {
  InpaintingEngine,
  InpaintingRuntimeProgress,
} from "./inpaintingEngine";
import {
  ensureQwenControlModels,
  ensureQwenTurboModel,
  ensureQwenImageModels,
} from "./qwenImageAssets";
import {
  qwenKoffiPath,
  ensureQwenControlRuntime,
  supportsQwenControlRuntime,
} from "./qwenControlRuntime";
import { QwenImageWorker } from "./qwenImageWorker";
import {
  prepareQwenPlatformGpu,
  type QwenNativeBackend,
} from "./qwenPlatformGpu";

const pool = new LeasedIdleResourcePool<InpaintingEngine>({
  idleTtlMs: 30_000,
  isReusable: () => true,
  dispose: (engine) => releaseModelResource(engine, () => engine.dispose()),
});

type Options = {
  appPaths: AppPaths;
  fluxBackend?: FluxBackend;
  computeGpuIndex?: number;
  signal?: AbortSignal;
  onProgress?: (event: InpaintingRuntimeProgress) => void;
};

export async function acquireQwenInpaintingEngine(options: Options) {
  options.signal?.throwIfAborted();
  const backend = await qwenBackend(options.fluxBackend);
  const gpu =
    backend === "cuda"
      ? await queryNvidiaGpuInfo(options.computeGpuIndex)
      : undefined;
  const gpuUuid = normalizeNvidiaGpuUuid(gpu?.nvidiaUuid);
  if (backend === "cuda" && !gpuUuid)
    throw new Error("Qwen Image 2.1을 실행할 NVIDIA GPU를 찾지 못했습니다.");
  const root = options.appPaths.dataRoot;
  const modelDir = join(root, "models", "inpainting", "qwen-image-2.1");
  const lease = await pool.acquire(
    JSON.stringify([
      modelDir,
      backend,
      gpuUuid ?? options.computeGpuIndex ?? 0,
    ]),
    async () => {
      const launch = await prepareWorker(
        options,
        modelDir,
        backend,
        gpu?.computeCapability,
      );
      const { models, adapter } = launch;
      const worker = new QwenImageWorker({
        ...launch,
        models,
        gpuUuid: gpuUuid ?? undefined,
        status: (status) =>
          options.onProgress?.({
            progressText: "Qwen Image 2.1",
            detail: gpuProgress[status],
            progressMode: "log-only",
          }),
        adapter,
      });
      const runRootDir = join(root, "tmp", "runtime", "qwen-image-inpainting");
      options.onProgress?.({
        progressText: "Qwen Image 2.1",
        detail:
          "control" in launch
            ? "Qwen Image 2.1 Fun ControlNet Union"
            : (adapter?.name ?? "Qwen Image 2.1 base"),
        progressMode: "log-only",
      });
      return {
        model: "qwen-image-2.1",
        modelPath: models.diffusion,
        runtimePath: launch.runtimePath,
        backend: `${backend}-native`,
        runRootDir,
        inpaint(bitmap, width, height, mask, windows, runOptions = {}) {
          return runFluxInpaint({
            bitmap,
            width,
            height,
            mask,
            windows,
            getWorker: () => worker,
            cropStrategy: "worker-resize",
            isolateWindowMasks: true,
            modelMaskIsTypography: true,
            runRootDir,
            runOptions: {
              ...runOptions,
              // The Qwen worker expands the detector instance for conditioning
              // at native resolution before encoding the crop.
              maskPaddingPx: 0,
              steps: 40,
              maxPixels: Math.min(runOptions.maxPixels ?? 1024 ** 2, 1024 ** 2),
            },
          });
        },
        dispose: () => worker.dispose(),
      } satisfies InpaintingEngine;
    },
  );
  return { engine: lease.resource, release: lease.release };
}

async function prepareWorker(
  options: Options,
  modelDir: string,
  backend: QwenNativeBackend | "cuda",
  capability?: number | null,
) {
  const runtimeDir = join(
    options.appPaths.dataRoot,
    "models",
    "inpainting",
    "qwen-image-runtime",
  );
  const download = { signal: options.signal, onProgress: options.onProgress };
  if (
    backend === "cuda" &&
    (await supportsQwenControlRuntime(capability, options.signal))
  ) {
    const runtime = await ensureQwenControlRuntime({ runtimeDir, ...download });
    const models = await ensureQwenControlModels({ modelDir, ...download });
    const script = join(
      options.appPaths.runtimeDir,
      "qwen-image-control-worker.py",
    );
    if (!existsSync(script))
      throw new Error("Qwen ControlNet 실행 파일을 찾을 수 없습니다.");
    return {
      executable: runtime.executable,
      runtimePath: runtime.executable,
      env: {
        CARROT_QWEN_KOFFI: qwenKoffiPath(options.appPaths.runtimeDir),
        PYTHONNOUSERSITE: "1",
        HF_HUB_OFFLINE: "1",
        TRANSFORMERS_OFFLINE: "1",
      },
      models,
      control: {
        ...runtime,
        script,
        models,
        getTurbo: optionalTurboModel(modelDir, options),
      },
      adapter: undefined,
    };
  }
  const launch = await prepareNativeInferenceLaunch({
    engine: "qwen-image",
    backend,
    runtimeDir,
    computeGpuIndex: options.computeGpuIndex,
    ...download,
  });
  const platformGpu =
    backend === "cuda"
      ? undefined
      : await prepareQwenPlatformGpu(
          launch.executable,
          launch.env,
          backend,
          options.computeGpuIndex,
          options.signal,
        );
  const models = await ensureQwenImageModels({ modelDir, ...download });
  return {
    ...nativeSessionRuntime(
      launch.executable,
      launch.env,
      options.appPaths.runtimeDir,
    ),
    models,
    platformGpu,
    adapter: verifiedAdapter(modelDir),
  };
}

function nativeSessionRuntime(
  executable: string,
  env: NodeJS.ProcessEnv,
  runtimeDir: string,
) {
  const nativeLibrary = join(
    dirname(executable),
    process.platform === "darwin"
      ? "libstable-diffusion.dylib"
      : "stable-diffusion.dll",
  );
  return {
    executable: process.execPath,
    runtimePath: nativeLibrary,
    nativeScript: join(runtimeDir, "qwen-native-session.cjs"),
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: "1",
      CARROT_QWEN_NATIVE_LIBRARY: nativeLibrary,
      CARROT_QWEN_KOFFI: qwenKoffiPath(runtimeDir),
      CARROT_QWEN_PNG: require.resolve("pngjs"),
    },
  };
}

function optionalTurboModel(modelDir: string, options: Options) {
  let cached: Promise<string | undefined> | undefined;
  return (signal?: AbortSignal) => {
    cached ??= ensureQwenTurboModel({
      modelDir,
      signal,
      onProgress: options.onProgress,
    }).catch((error: unknown) => {
      if (signal?.aborted) {
        cached = undefined;
        throw error;
      }
      options.onProgress?.({
        progressText: "Qwen Image 2.1",
        detail: "Turbo 가중치를 준비할 수 없어 기존 Q8 모델로 계속합니다.",
        progressMode: "log-only",
      });
      return undefined;
    });
    return cached;
  };
}

async function qwenBackend(
  requested?: FluxBackend,
): Promise<QwenNativeBackend | "cuda"> {
  if (process.platform === "darwin" && process.arch === "arm64") {
    if (Number(release().split(".")[0]) < 25)
      throw new Error(
        "Qwen Image 2.1 Metal 실행기에는 macOS 26 이상이 필요합니다.",
      );
    return "metal";
  }
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error(
      "Qwen Image 2.1에는 Windows x64 또는 Apple Silicon이 필요합니다.",
    );
  const configured: Partial<Record<FluxBackend, QwenNativeBackend | "cuda">> = {
    "cuda-native": "cuda",
    "cuda-sm75-experimental": "cuda",
    "vulkan-native": "vulkan",
    "rocm-native": "rocm",
    "zluda-native": "rocm",
  };
  const backend = requested && configured[requested];
  if (backend) return backend;
  return detectQwenBackend();
}

async function detectQwenBackend() {
  const gpu = await detectBestGpuInfo();
  if (gpu?.vendor === "intel" && gpu.supportsVulkan) return "vulkan";
  if (gpu?.vendor === "amd")
    return resolveNativeRocmGpuSupport(gpu, "qwen") ? "rocm" : "vulkan";
  if (gpu?.vendor === "nvidia") return "cuda";
  throw new Error("Qwen Image 2.1을 실행할 호환 GPU를 찾지 못했습니다.");
}

export function disposeCachedQwenInpaintingEngine(reason: string) {
  return pool.dispose(reason);
}

function verifiedAdapter(modelDir: string) {
  const directory = join(modelDir, "adapters");
  const name = "qwen21-printed-focus";
  const adapterFile = join(directory, name + ".safetensors");
  const hasAdapter = existsSync(adapterFile);
  if (
    hasAdapter &&
    sha256FileSync(adapterFile) !==
      "233564638432a0c9bcce77827a06d99cd5e38432f258605858ee8e8beb5db601"
  )
    throw new Error(
      "Qwen 인페인팅 어댑터의 SHA-256이 검증된 가중치와 다릅니다.",
    );
  return hasAdapter ? { directory, name, strength: 0.65 } : undefined;
}

const gpuProgress = {
  telemetry: "GPU 메모리 상태를 다시 확인한 뒤 같은 영역을 재개합니다.",
  inference:
    "다른 로컬 이미지 작업이 GPU를 사용 중입니다. 작업이 끝나면 이 영역을 다시 시작합니다.",
  memory:
    "11 GiB 한도와 GPU 여유 공간에 맞게 처리 영역의 해상도를 조정하고 있습니다.",
  ready: "GPU 사용이 가능해져 현재 영역 처리를 재개합니다.",
} as const;
