import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  InpaintingModel,
  KoharuInpaintingBackend,
} from "../../shared/inpaintingSettingsTypes";
import { ensureFluxZludaSupportRuntime } from "./fluxAssets";
import {
  createCombinedDownloadProgress,
  ensureRemoteFile,
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
  throw new Error(`Koharu 모델이 아닙니다: ${model}`);
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
    "AOT 인페인팅",
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
  let cudaRuntimeDir: string | undefined;
  let zludaRuntimeRoot: string | undefined;
  if (options.backend === "zluda-native") {
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
    progressText: "Koharu 인페인팅 준비 완료",
    detail: `${options.model} / ${options.backend}`,
    progressMode: "log-only",
    installLogLine: `Koharu ${options.model} 인페인팅 런타임을 사용합니다: ${basename(runtimePath)}`,
  });
  logInpaintingRuntimeInfo("Koharu runtime selected", {
    model: options.model,
    backend: options.backend,
    computePolicy: describeKoharuComputePolicy(options.backend),
    runtimePath,
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
      `${KOHARU_RUNTIME_EXECUTABLE}를 찾지 못했습니다. 개발 환경에서는 tools/${KOHARU_RUNNER_DIR}에서 cargo build --release를 실행하거나 MGT_KOHARU_INPAINT_EXE로 경로를 지정하세요.`,
    );
  }

  const managedDir = join(options.runtimeDir, KOHARU_RUNNER_DIR);
  const managedPath = join(managedDir, KOHARU_RUNTIME_EXECUTABLE);
  await mkdir(managedDir, { recursive: true });
  await copyFile(sourcePath, managedPath);
  options.onProgress?.({
    progressText: "Koharu 실행 파일 준비 중",
    detail: basename(sourcePath),
    progressMode: "log-only",
    installLogLine: `Koharu 실행 파일을 앱 데이터 캐시에 갱신했습니다: ${basename(dirname(sourcePath))}/${basename(sourcePath)}`,
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
