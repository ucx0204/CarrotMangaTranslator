import { prepareNativeInferenceLaunch } from "../runtimeSupport/nativeInferenceLaunch";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  InpaintingModel,
  KoharuInpaintingModel,
  KoharuInpaintingBackend,
} from "../../shared/inpaintingSettingsTypes";
import {
  ensureRemoteFile,
  hfResolveUrl,
} from "../runtimeSupport/modelDownloads";
import { createCombinedDownloadProgress } from "./fluxAssets/progress";
import { MAX_REMOTE_SUPPORT_ASSET_BYTES } from "../runtimeSupport/downloadBudgets";
import { tMain } from "./localization";
import { logInpaintingRuntimeInfo } from "./inpaintingRuntimeLogger";
import type { InpaintingRuntimeProgress } from "./inpaintingEngine";
import type { KoharuWorkerLaunchSpec } from "./koharuWorkerTypes";
import {
  ensureManagedKoharuRunner,
  KOHARU_RUNNER_DIRECTORY,
} from "../runtimeSupport/koharuRunner";

const AOT_MODEL_REPO = "mayocream/aot-inpainting";
export const AOT_MODEL_REVISION = "bde6131f9d3ef841b435507def8534715ac8e87c";
const AOT_CONFIG_FILE = "config.json";
const AOT_MODEL_FILE = "model.safetensors";
export const AOT_MODEL_SHA256 =
  "1b4fea17a84a228c2097a42ab2f403357f07bb56ae022dc243b40817b7aa87d1";

const LAMA_MODEL_REPO = "mayocream/lama-manga";
export const LAMA_MODEL_REVISION = "bc1fd58e8d92133f437f62f4f18f7ee3aa7503f8";
const LAMA_MODEL_FILE = "lama-manga.safetensors";
export const LAMA_MODEL_SHA256 =
  "a790515e9da839b8d89af7d565ceb110d908b7d6fbdb991f2acb2ec7d9b08bdb";

export type KoharuModelFiles =
  | {
      model: "lama-manga";
      weightsPath: string;
      configPath?: undefined;
    }
  | {
      model: "aot-inpainting";
      weightsPath: string;
      configPath: string;
    };

type KoharuWorkerLaunchOptions = {
  runtimeDir: string;
  cudaRuntimeDir?: string;
  computeGpuIndex?: number;
  model: KoharuInpaintingModel;
  modelFiles: KoharuModelFiles;
  backend: KoharuInpaintingBackend;
  signal?: AbortSignal;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
};

export function resolveKoharuModelFiles(model: InpaintingModel): {
  repo: string;
  files: string[];
} {
  if (model === "aot-inpainting") {
    return {
      repo: AOT_MODEL_REPO,
      files: [AOT_CONFIG_FILE, AOT_MODEL_FILE],
    };
  }
  if (model === "lama-manga") {
    return {
      repo: LAMA_MODEL_REPO,
      files: [LAMA_MODEL_FILE],
    };
  }
  throw new Error(tMain("inpainting.errors.notKoharuModel", { model }));
}

export async function ensureKoharuModelAssets(options: {
  model: KoharuInpaintingModel;
  modelDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
}): Promise<KoharuModelFiles> {
  const modelFiles = resolveKoharuModelFiles(options.model);
  if (options.model === "lama-manga") {
    const [fileName] = modelFiles.files;
    return {
      model: "lama-manga",
      weightsPath: await ensureRemoteFile({
        modelDir: options.modelDir,
        fileName,
        label: "LaMa Manga",
        url: hfResolveUrl(modelFiles.repo, fileName, LAMA_MODEL_REVISION),
        expectedSha256: LAMA_MODEL_SHA256,
        maximumBytes: MAX_REMOTE_SUPPORT_ASSET_BYTES,
        signal: options.signal,
        onProgress: options.onProgress,
      }),
    };
  }

  const [configFile, weightsFile] = modelFiles.files;
  const download = createCombinedDownloadProgress(
    options.onProgress,
    tMain("inpainting.assets.aot"),
  );
  const [configPath, weightsPath] = await Promise.all([
    ensureRemoteFile({
      modelDir: options.modelDir,
      fileName: configFile,
      label: "AOT Inpainting config",
      url: hfResolveUrl(modelFiles.repo, configFile, AOT_MODEL_REVISION),
      minimumBytes: 1,
      maximumBytes: MAX_REMOTE_SUPPORT_ASSET_BYTES,
      signal: options.signal,
      onProgress: download.forFile(),
    }),
    ensureRemoteFile({
      modelDir: options.modelDir,
      fileName: weightsFile,
      label: "AOT Inpainting",
      url: hfResolveUrl(modelFiles.repo, weightsFile, AOT_MODEL_REVISION),
      expectedSha256: AOT_MODEL_SHA256,
      maximumBytes: MAX_REMOTE_SUPPORT_ASSET_BYTES,
      signal: options.signal,
      onProgress: download.forFile(),
    }),
  ]);
  return {
    model: "aot-inpainting",
    configPath,
    weightsPath,
  };
}

export async function ensureKoharuWorkerLaunch(
  options: KoharuWorkerLaunchOptions,
): Promise<KoharuWorkerLaunchSpec> {
  assertKoharuBackendPlatform(options.backend);
  await mkdir(options.runtimeDir, { recursive: true });
  const managedRunner = await ensureManagedKoharuRunner(options);
  const backend =
    options.backend === "zluda-native" ? "rocm-native" : options.backend;
  if (backend === "auto")
    throw new Error("Koharu backend must be resolved before installation");
  const native = await prepareNativeInferenceLaunch({
    ...options,
    executable: managedRunner.path,
    engine: "torch",
    backend:
      backend === "cpu"
        ? "cpu"
        : backend === "cuda-native"
          ? "cuda"
          : backend === "rocm-native"
            ? "rocm"
            : "metal",
  });
  const runtimePath = native.executable;
  reportKoharuExecutablePreparing(options, managedRunner.sourcePath);
  const args = [
    "--model",
    options.model,
    "--weights",
    options.modelFiles.weightsPath,
    "--backend",
    backend,
    "--native-runtime",
    native.manifest,
  ];
  if (options.modelFiles.configPath) {
    args.push("--config", options.modelFiles.configPath);
  }

  const env: NodeJS.ProcessEnv = {
    ...native.env,
    KOHARU_DATA_ROOT: join(options.runtimeDir, "koharu-data"),
  };

  reportKoharuReady(options, runtimePath);
  logInpaintingRuntimeInfo("Koharu runtime selected", {
    model: options.model,
    backend,
    computePolicy: describeKoharuComputePolicy(options.backend),
    runtimePath,
    weightsPath: options.modelFiles.weightsPath,
    configPath: options.modelFiles.configPath ?? null,
  });

  return {
    backend,
    executable: runtimePath,
    runtimePath,
    label: `Koharu ${options.model}`,
    args,
    env,
  };
}

function reportKoharuExecutablePreparing(
  options: KoharuWorkerLaunchOptions,
  sourcePath: string,
): void {
  options.onProgress?.({
    progressText: tMain("inpainting.runtime.koharuExecutablePreparing"),
    detail: basename(sourcePath),
    progressMode: "log-only",
    installLogLine: tMain("inpainting.runtime.koharuExecutableLog", {
      file: `${KOHARU_RUNNER_DIRECTORY}/${basename(sourcePath)}`,
    }),
  });
}

function reportKoharuReady(
  options: KoharuWorkerLaunchOptions,
  runtimePath: string,
): void {
  options.onProgress?.({
    progressText: tMain("inpainting.runtime.koharuReady"),
    detail: `${options.model} / ${options.backend}`,
    progressMode: "log-only",
    installLogLine: tMain("inpainting.runtime.koharuReadyLog", {
      model: options.model,
      file: basename(runtimePath),
    }),
  });
}

function assertKoharuBackendPlatform(backend: KoharuInpaintingBackend): void {
  if (
    backend === "metal-native" &&
    (process.platform !== "darwin" || process.arch !== "arm64")
  ) {
    throw new Error(
      "Koharu Metal 런타임은 Apple Silicon(macOS arm64)에서만 사용할 수 있습니다.",
    );
  }
}

function describeKoharuComputePolicy(
  backend: KoharuInpaintingBackend,
): "Auto" | "CpuOnly" | "PreferGpu" {
  if (backend === "auto") {
    return "Auto";
  }
  return backend === "cpu" ? "CpuOnly" : "PreferGpu";
}
