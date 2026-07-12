import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import type {
  InpaintingModel,
  KoharuInpaintingBackend,
} from "../../shared/inpaintingSettingsTypes";
import { ensureFluxZludaSupportRuntime } from "./fluxAssets";
import { tMain } from "./localization";
import {
  createCombinedDownloadProgress,
  ensureFluxCudaRuntime,
  ensureRemoteFile,
  FLUX_CUDA_RUNTIME_DIR,
  hfResolveUrl,
} from "./fluxAssets";
import { logInpaintingRuntimeInfo } from "./inpaintingRuntimeLogger";
import type { InpaintingRuntimeProgress } from "./inpaintingEngine";
import type { KoharuWorkerLaunchSpec } from "./koharuWorkerTypes";

const AOT_MODEL_REPO = "mayocream/aot-inpainting";
const AOT_CONFIG_FILE = "config.json";
const AOT_MODEL_FILE = "model.safetensors";

const LAMA_MODEL_REPO = "mayocream/lama-manga";
const LAMA_MODEL_FILE = "lama-manga.safetensors";

const KOHARU_RUNTIME_EXECUTABLE = "mgt-koharu-inpaint-runner.exe";
const KOHARU_RUNNER_DIR = "mgt-koharu-inpaint-runner";

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
  model: Exclude<InpaintingModel, "flux-klein">;
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
        url: hfResolveUrl(modelFiles.repo, fileName),
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
      url: hfResolveUrl(modelFiles.repo, configFile),
      signal: options.signal,
      onProgress: download.forFile(),
    }),
    ensureRemoteFile({
      modelDir: options.modelDir,
      fileName: weightsFile,
      label: "AOT Inpainting",
      url: hfResolveUrl(modelFiles.repo, weightsFile),
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

export async function ensureKoharuWorkerLaunch(options: {
  runtimeDir: string;
  cudaRuntimeDir?: string;
  model: Exclude<InpaintingModel, "flux-klein">;
  modelFiles: KoharuModelFiles;
  backend: KoharuInpaintingBackend;
  signal?: AbortSignal;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
}): Promise<KoharuWorkerLaunchSpec> {
  await mkdir(options.runtimeDir, { recursive: true });
  const runtimePath = await ensureManagedKoharuRunner(options);
  const args = [
    "--model",
    options.model,
    "--weights",
    options.modelFiles.weightsPath,
    "--backend",
    options.backend,
  ];
  if (options.modelFiles.configPath) {
    args.push("--config", options.modelFiles.configPath);
  }

  const env: NodeJS.ProcessEnv = {
    KOHARU_DATA_ROOT: join(options.runtimeDir, "koharu-data"),
  };
  let cudaRuntimeRoot: string | undefined;
  let cudaRuntimeDir: string | undefined;
  let zludaRuntimeRoot: string | undefined;
  if (options.backend === "cuda-native") {
    cudaRuntimeRoot = options.cudaRuntimeDir ?? options.runtimeDir;
    await ensureFluxCudaRuntime({
      runtimeDir: cudaRuntimeRoot,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    cudaRuntimeDir = join(cudaRuntimeRoot, FLUX_CUDA_RUNTIME_DIR);
    args.push("--cuda-runtime-dir", cudaRuntimeDir);
    env.PATH = prependPathEntry(env.PATH, cudaRuntimeDir);
  } else if (options.backend === "zluda-native") {
    cudaRuntimeDir = await ensureFluxZludaSupportRuntime(options);
    zludaRuntimeRoot = join(options.runtimeDir, "koharu-zluda");
    args.push(
      "--require-zluda",
      "--zluda-runtime-root",
      zludaRuntimeRoot,
      "--cuda-runtime-dir",
      cudaRuntimeDir,
    );
    env.KOHARU_DATA_ROOT = zludaRuntimeRoot;
  }

  options.onProgress?.({
    progressText: tMain("inpainting.runtime.koharuReady"),
    detail: `${options.model} / ${options.backend}`,
    progressMode: "log-only",
    installLogLine: tMain("inpainting.runtime.koharuReadyLog", {
      model: options.model,
      file: basename(runtimePath),
    }),
  });
  logInpaintingRuntimeInfo("Koharu runtime selected", {
    model: options.model,
    backend: options.backend,
    computePolicy: describeKoharuComputePolicy(options.backend),
    runtimePath,
    cudaRuntimeRoot,
    weightsPath: options.modelFiles.weightsPath,
    configPath: options.modelFiles.configPath ?? null,
    cudaRuntimeDir,
    zludaRuntimeRoot,
  });

  return {
    backend: options.backend,
    executable: runtimePath,
    runtimePath,
    label: `Koharu ${options.model}`,
    args,
    env,
  };
}

async function ensureManagedKoharuRunner(options: {
  runtimeDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
}): Promise<string> {
  throwIfAborted(options.signal);
  const sourcePath = resolveKoharuRunnerSource();
  if (!sourcePath) {
    throw new Error(
      tMain("inpainting.errors.koharuExecutableMissing", {
        executable: KOHARU_RUNTIME_EXECUTABLE,
        directory: KOHARU_RUNNER_DIR,
      }),
    );
  }

  const managedDir = join(options.runtimeDir, KOHARU_RUNNER_DIR);
  const managedPath = join(managedDir, KOHARU_RUNTIME_EXECUTABLE);
  await mkdir(managedDir, { recursive: true });
  await copyFile(sourcePath, managedPath);
  options.onProgress?.({
    progressText: tMain("inpainting.runtime.koharuExecutablePreparing"),
    detail: basename(sourcePath),
    progressMode: "log-only",
    installLogLine: tMain("inpainting.runtime.koharuExecutableLog", {
      file: `${basename(dirname(sourcePath))}/${basename(sourcePath)}`,
    }),
  });
  return managedPath;
}

function resolveKoharuRunnerSource(): string | null {
  const explicit = process.env.MGT_KOHARU_INPAINT_EXE;
  if (explicit && existsSync(explicit)) {
    return explicit;
  }
  for (const toolsRoot of resolveKoharuRunnerToolsRoots()) {
    for (const candidate of [
      join(toolsRoot, KOHARU_RUNNER_DIR, KOHARU_RUNTIME_EXECUTABLE),
      join(
        toolsRoot,
        KOHARU_RUNNER_DIR,
        "target",
        "release",
        KOHARU_RUNTIME_EXECUTABLE,
      ),
    ]) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function resolveKoharuRunnerToolsRoots(): string[] {
  return [
    process.resourcesPath ? join(process.resourcesPath, "tools") : undefined,
    join(process.cwd(), "tools"),
  ].filter((value): value is string => Boolean(value));
}

function describeKoharuComputePolicy(
  backend: KoharuInpaintingBackend,
): "Auto" | "CpuOnly" | "PreferGpu" {
  if (backend === "auto") {
    return "Auto";
  }
  return backend === "cpu" ? "CpuOnly" : "PreferGpu";
}

function prependPathEntry(
  currentPath: string | undefined,
  entry: string,
): string {
  return [entry, currentPath].filter(Boolean).join(delimiter);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
