import { once } from "node:events";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { FluxBackend } from "../../shared/types";
import { sanitizeFluxRuntimeStderr, type FluxWorkerBackend, type FluxWorkerLaunchSpec } from "./fluxWorker";

const AdmZip = require("adm-zip");

export const FLUX_RUNTIME_EXECUTABLE = "mgt-flux-klein.exe";
export const FLUX_MODEL_REPO = "unsloth/FLUX.2-klein-4B-GGUF";
export const FLUX_MODEL_FILE = "flux-2-klein-4b-Q4_K_M.gguf";
export const FLUX_VAE_REPO = "black-forest-labs/FLUX.2-small-decoder";
export const FLUX_VAE_FILE = "diffusion_pytorch_model.safetensors";
const FLUX_RUNNER_DIR = "mgt-flux-klein";
const FLUX_CUDA_RUNTIME_DIR = "mgt-flux-cuda12.9";
const FLUX_CUDA_RUNTIME_MARKER = ".mgt-runtime.json";
const FLUX_PYTHON_WORKER = "flux-klein-python-worker.py";
const FLUX_PYTHON_RUNTIME_MARKER = ".mgt-flux-python-runtime.json";
const FLUX_DIFFUSERS_MODEL_ID = "black-forest-labs/FLUX.2-klein-4B";
const FLUX_ROCM_TORCH_INDEX_URL = "https://download.pytorch.org/whl/rocm7.1";
const FLUX_CPU_TORCH_INDEX_URL = "https://download.pytorch.org/whl/cpu";
const FLUX_PYTHON_DEFAULT_MODE = "klein-edit-composite";
const CUDA_REDIST_BASE_URL = "https://developer.download.nvidia.com/compute/cuda/redist";
const CUDNN_REDIST_BASE_URL = "https://developer.download.nvidia.com/compute/cudnn/redist";
const CUDA_REDIST_MANIFEST_URL = `${CUDA_REDIST_BASE_URL}/redistrib_12.9.0.json`;
const CUDNN_REDIST_MANIFEST_URL = `${CUDNN_REDIST_BASE_URL}/redistrib_9.21.0.json`;
const FLUX_CUDA_DLLS = new Set(["cublas64_12.dll", "cublasLt64_12.dll", "cudart64_12.dll", "curand64_10.dll"]);
const FLUX_CUDNN_DLLS = new Set([
  "cudnn64_9.dll",
  "cudnn_adv64_9.dll",
  "cudnn_cnn64_9.dll",
  "cudnn_engines_precompiled64_9.dll",
  "cudnn_engines_runtime_compiled64_9.dll",
  "cudnn_engines_tensor_ir64_9.dll",
  "cudnn_graph64_9.dll",
  "cudnn_heuristic64_9.dll",
  "cudnn_ops64_9.dll"
]);

export type FluxAssetProgress = {
  progressText: string;
  detail?: string;
  progressMode?: "determinate" | "indeterminate" | "log-only";
  progressPercent?: number;
  progressBytes?: number;
  progressTotalBytes?: number;
  installLogLine?: string;
};

type RemoteFileMetadata = {
  url: string;
  bytes: number;
  downloadedAt: string;
};

type NvidiaRedistPackage = {
  relative_path: string;
  size?: number;
};

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
    installLogLine: `MGT Flux Klein 런타임을 사용합니다: ${basename(runtimePath)}`
  });
  return runtimePath;
}

export async function ensureFluxWorkerLaunch(options: {
  runtimeDir: string;
  modelDir: string;
  backend: FluxBackend;
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
      args: []
    };
  }
  return ensureFluxPythonRuntime({ ...options, backend });
}

async function ensureManagedFluxRunner(options: {
  runtimeDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  const managedDir = join(options.runtimeDir, FLUX_RUNNER_DIR);
  const managedPath = join(managedDir, FLUX_RUNTIME_EXECUTABLE);
  if (isExecutableFile(managedPath)) {
    return managedPath;
  }

  const source = findFirstExecutable([
    process.env.MGT_FLUX_KLEIN_EXE,
    process.resourcesPath ? join(process.resourcesPath, "tools", FLUX_RUNNER_DIR, FLUX_RUNTIME_EXECUTABLE) : undefined,
    join(process.cwd(), "tools", FLUX_RUNNER_DIR, FLUX_RUNTIME_EXECUTABLE)
  ]);
  if (!source) {
    throw new Error(
      `${FLUX_RUNTIME_EXECUTABLE}를 찾지 못했습니다. 설치 파일에 Flux Klein 실행 파일이 포함되어 있어야 합니다. ` +
        `개발 환경에서는 node scripts/prepare-flux-klein-runner.cjs를 실행하거나 MGT_FLUX_KLEIN_EXE로 경로를 지정하세요.`
    );
  }

  throwIfAborted(options.signal);
  await mkdir(managedDir, { recursive: true });
  await copyFile(source, managedPath);
  options.onProgress?.({
    progressText: "Flux 실행 파일 준비 중",
    detail: FLUX_RUNTIME_EXECUTABLE,
    progressMode: "log-only",
    installLogLine: `Flux 실행 파일을 앱 데이터 캐시에 복사했습니다: ${FLUX_RUNTIME_EXECUTABLE}`
  });
  return managedPath;
}

async function ensureFluxPythonRuntime(options: {
  runtimeDir: string;
  modelDir: string;
  backend: Exclude<FluxWorkerBackend, "cuda-native">;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<FluxWorkerLaunchSpec> {
  await mkdir(options.runtimeDir, { recursive: true });
  const runtimeName = options.backend === "python-rocm" ? "mgt-flux-python-rocm" : "mgt-flux-python-cpu";
  const runtimeDir = join(options.runtimeDir, runtimeName);
  const venvDir = join(runtimeDir, ".venv");
  const pythonPath = pythonExecutablePath(venvDir);
  const workerPath = join(runtimeDir, FLUX_PYTHON_WORKER);
  const markerPath = join(runtimeDir, FLUX_PYTHON_RUNTIME_MARKER);
  const torchIndexUrl = resolveTorchIndexUrl(options.backend);
  const torchPackages = ["torch", "torchvision"];
  const extraPackages = resolvePythonFluxPackages(options.backend);
  const expectedMarker = {
    backend: options.backend,
    torchIndexUrl,
    torchPackages,
    packages: extraPackages,
    worker: FLUX_PYTHON_WORKER
  };

  if (!(await isCurrentFluxPythonRuntime(pythonPath, markerPath, expectedMarker))) {
    await rm(runtimeDir, { recursive: true, force: true });
    await mkdir(runtimeDir, { recursive: true });
    await ensureFluxPythonWorker(runtimeDir);
    options.onProgress?.({
      progressText: options.backend === "python-rocm" ? "Flux ROCm 런타임 설치 중" : "Flux CPU 런타임 설치 중",
      detail: "Python venv 생성",
      progressMode: "indeterminate",
      installLogLine: "Flux Python 가상환경을 생성합니다."
    });
    const basePython = await findPythonCommand(options.signal);
    await runCommand(basePython.command, [...basePython.args, "-m", "venv", venvDir], { signal: options.signal });
    await runCommand(pythonPath, ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"], {
      signal: options.signal,
      onLine: (line) => emitPythonInstallLog(options, line)
    });
    options.onProgress?.({
      progressText: options.backend === "python-rocm" ? "Flux ROCm PyTorch 설치 중" : "Flux CPU PyTorch 설치 중",
      detail: torchIndexUrl,
      progressMode: "indeterminate",
      installLogLine: `PyTorch 설치 인덱스: ${torchIndexUrl}`
    });
    await runCommand(pythonPath, ["-m", "pip", "install", "--index-url", torchIndexUrl, ...torchPackages], {
      signal: options.signal,
      onLine: (line) => emitPythonInstallLog(options, line)
    });
    options.onProgress?.({
      progressText: "Flux Python 패키지 설치 중",
      detail: extraPackages.join(" "),
      progressMode: "indeterminate",
      installLogLine: "diffusers/transformers/accelerate 패키지를 설치합니다."
    });
    await runCommand(pythonPath, ["-m", "pip", "install", ...extraPackages], {
      signal: options.signal,
      onLine: (line) => emitPythonInstallLog(options, line)
    });
    await verifyFluxPythonRuntime(pythonPath, options.backend, options.signal);
    await writeFile(markerPath, `${JSON.stringify(expectedMarker, null, 2)}\n`, "utf8");
  } else {
    await ensureFluxPythonWorker(runtimeDir);
  }

  const modelId = process.env.MANGA_TRANSLATOR_FLUX_PYTHON_MODEL_ID ?? process.env.MGT_FLUX_PYTHON_MODEL_ID ?? FLUX_DIFFUSERS_MODEL_ID;
  const mode = resolveFluxPythonMode();
  await mkdir(options.modelDir, { recursive: true });
  await ensureFluxPythonModelCache({
    pythonPath,
    modelDir: options.modelDir,
    modelId,
    signal: options.signal,
    onProgress: options.onProgress
  });
  options.onProgress?.({
    progressText: "Flux Python 런타임 준비 완료",
    detail: `${options.backend === "python-rocm" ? "ROCm" : "CPU"} · ${modelId}`,
    progressMode: "log-only",
    installLogLine: `Flux Python ${options.backend === "python-rocm" ? "ROCm" : "CPU"} 런타임을 사용합니다.`
  });
  return {
    backend: options.backend,
    executable: pythonPath,
    runtimePath: pythonPath,
    label: options.backend === "python-rocm" ? "Flux Python ROCm" : "Flux Python CPU",
    args: [
      "-u",
      workerPath,
      "--backend",
      options.backend === "python-rocm" ? "rocm" : "cpu",
      "--model-id",
      modelId,
      "--mode",
      mode,
      "--cache-dir",
      options.modelDir
    ],
    env: {
      HF_HOME: options.modelDir,
      HUGGINGFACE_HUB_CACHE: join(options.modelDir, "hub")
    }
  };
}

async function ensureFluxCudaRuntime(options: {
  runtimeDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<void> {
  const cudaDir = join(options.runtimeDir, FLUX_CUDA_RUNTIME_DIR);
  if (await isCurrentFluxCudaRuntime(cudaDir)) {
    options.onProgress?.({
      progressText: "Flux CUDA 런타임 캐시 사용",
      detail: FLUX_CUDA_RUNTIME_DIR,
      progressMode: "log-only",
      installLogLine: "캐시된 Flux CUDA/cuDNN 런타임을 사용합니다."
    });
    return;
  }

  await rm(cudaDir, { recursive: true, force: true });
  await mkdir(cudaDir, { recursive: true });
  const downloadsDir = join(options.runtimeDir, ".downloads");
  await mkdir(downloadsDir, { recursive: true });

  const cudaManifest = await readJsonUrl(CUDA_REDIST_MANIFEST_URL, options.signal);
  const cudaPackages: NvidiaRedistPackage[] = [
    readNvidiaRedistPackage(cudaManifest, "libcublas", "windows-x86_64"),
    readNvidiaRedistPackage(cudaManifest, "cuda_cudart", "windows-x86_64"),
    readNvidiaRedistPackage(cudaManifest, "libcurand", "windows-x86_64")
  ].filter((entry): entry is NvidiaRedistPackage => Boolean(entry));
  if (cudaPackages.length !== 3) {
    throw new Error("NVIDIA CUDA 12.9 런타임 목록에서 필요한 DLL 패키지를 찾지 못했습니다.");
  }

  const cudnnManifest = await readJsonUrl(CUDNN_REDIST_MANIFEST_URL, options.signal);
  const cudnnPackage = readNvidiaRedistPackage(cudnnManifest, "cudnn", "windows-x86_64", "cuda12");
  if (!cudnnPackage) {
    throw new Error("NVIDIA cuDNN 9.21 CUDA 12 런타임 패키지를 찾지 못했습니다.");
  }

  for (const entry of cudaPackages) {
    const archivePath = await downloadRuntimeArchive({
      ...options,
      downloadsDir,
      entry,
      baseUrl: CUDA_REDIST_BASE_URL,
      label: "Flux CUDA 런타임"
    });
    extractSelectedZipEntries(archivePath, cudaDir, (fileName) => FLUX_CUDA_DLLS.has(fileName));
  }

  const cudnnArchivePath = await downloadRuntimeArchive({
    ...options,
    downloadsDir,
    entry: cudnnPackage,
    baseUrl: CUDNN_REDIST_BASE_URL,
    label: "Flux cuDNN 런타임"
  });
  extractSelectedZipEntries(cudnnArchivePath, cudaDir, (fileName) => FLUX_CUDNN_DLLS.has(fileName));

  if (!(await hasFluxCudaRuntimeFiles(cudaDir))) {
    throw new Error("Flux CUDA/cuDNN 런타임 설치가 완료되지 않았습니다.");
  }
  await writeFile(runtimeMarkerPath(cudaDir), `${JSON.stringify({
    cudaManifest: CUDA_REDIST_MANIFEST_URL,
    cudnnManifest: CUDNN_REDIST_MANIFEST_URL,
    installedAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
  options.onProgress?.({
    progressText: "Flux CUDA 런타임 설치 완료",
    detail: FLUX_CUDA_RUNTIME_DIR,
    progressMode: "determinate",
    progressPercent: 1,
    installLogLine: "Flux CUDA/cuDNN 런타임 준비가 완료되었습니다."
  });
}

async function downloadRuntimeArchive(options: {
  downloadsDir: string;
  entry: { relative_path: string; size?: number };
  baseUrl: string;
  label: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  const url = `${options.baseUrl}/${options.entry.relative_path}`;
  const fileName = basename(options.entry.relative_path);
  const outputPath = join(options.downloadsDir, fileName);
  await downloadToFile({
    url,
    outputPath,
    signal: options.signal,
    progressText: `${options.label} 다운로드 중`,
    label: fileName,
    onProgress: options.onProgress
  });
  return outputPath;
}

async function readJsonUrl(url: string, signal?: AbortSignal): Promise<unknown> {
  throwIfAborted(signal);
  const response = await fetch(url, { signal, headers: { "User-Agent": "manga-gemma-translator" } });
  if (!response.ok) {
    throw new Error(`${url} 요청에 실패했습니다 (${response.status}).`);
  }
  return response.json();
}

function readNvidiaRedistPackage(
  manifest: unknown,
  packageName: string,
  platform: string,
  variant?: string
): NvidiaRedistPackage | null {
  const packageRecord = asJsonRecord(asJsonRecord(manifest)[packageName]);
  const platformValue = packageRecord[platform];
  const value = variant ? asJsonRecord(platformValue)[variant] : platformValue;
  const record = asJsonRecord(value);
  const relativePath = typeof record.relative_path === "string" ? record.relative_path : "";
  if (!relativePath) {
    return null;
  }
  const size = typeof record.size === "number" && Number.isFinite(record.size) ? record.size : undefined;
  return {
    relative_path: relativePath,
    ...(size === undefined ? {} : { size })
  };
}

function asJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function extractSelectedZipEntries(archivePath: string, outputDir: string, shouldExtract: (fileName: string) => boolean): void {
  const zip = new AdmZip(archivePath);
  let extracted = 0;
  for (const item of zip.getEntries()) {
    if (item.isDirectory) {
      continue;
    }
    const fileName = basename(item.entryName);
    if (!fileName || !shouldExtract(fileName)) {
      continue;
    }
    zip.extractEntryTo(item, outputDir, false, true, false, fileName);
    extracted += 1;
  }
  if (extracted === 0) {
    throw new Error(`${basename(archivePath)}에서 필요한 런타임 DLL을 찾지 못했습니다.`);
  }
}

async function isCurrentFluxCudaRuntime(cudaDir: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(runtimeMarkerPath(cudaDir), "utf8")) as { cudnnManifest?: string };
    return marker?.cudnnManifest === CUDNN_REDIST_MANIFEST_URL && await hasFluxCudaRuntimeFiles(cudaDir);
  } catch {
    return false;
  }
}

async function hasFluxCudaRuntimeFiles(cudaDir: string): Promise<boolean> {
  return [...FLUX_CUDA_DLLS, ...FLUX_CUDNN_DLLS].every((fileName) => {
    try {
      return statSync(join(cudaDir, fileName)).size > 0;
    } catch {
      return false;
    }
  });
}

function runtimeMarkerPath(cudaDir: string): string {
  return join(cudaDir, FLUX_CUDA_RUNTIME_MARKER);
}

function resolveFluxWorkerBackend(backend: FluxBackend): FluxWorkerBackend {
  if (backend === "python-rocm" || backend === "python-cpu") {
    return backend;
  }
  return "cuda-native";
}

async function ensureFluxPythonWorker(runtimeDir: string): Promise<string> {
  await mkdir(runtimeDir, { recursive: true });
  const workerPath = join(runtimeDir, FLUX_PYTHON_WORKER);
  if (isExecutableFile(workerPath)) {
    return workerPath;
  }
  const sourceWorker = findFluxPythonWorkerSource();
  if (!sourceWorker) {
    throw new Error(`${FLUX_PYTHON_WORKER}를 찾지 못했습니다. 앱 런타임 파일을 다시 준비하세요.`);
  }
  await copyFile(sourceWorker, workerPath);
  return workerPath;
}

function findFluxPythonWorkerSource(): string | null {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, "app-runtime", FLUX_PYTHON_WORKER) : undefined,
    join(process.cwd(), "out", "app-runtime", FLUX_PYTHON_WORKER),
    join(process.cwd(), "src", "main", "runtime", FLUX_PYTHON_WORKER)
  ];
  for (const candidate of candidates) {
    if (candidate && isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function isCurrentFluxPythonRuntime(
  pythonPath: string,
  markerPath: string,
  expectedMarker: { backend: FluxWorkerBackend; torchIndexUrl: string; worker: string }
): Promise<boolean> {
  try {
    if (!isExecutableFile(pythonPath) || !isExecutableFile(join(dirname(markerPath), expectedMarker.worker))) {
      return false;
    }
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Partial<typeof expectedMarker>;
    return (
      marker.backend === expectedMarker.backend &&
      marker.torchIndexUrl === expectedMarker.torchIndexUrl &&
      marker.worker === expectedMarker.worker
    );
  } catch {
    return false;
  }
}

function pythonExecutablePath(venvDir: string): string {
  return process.platform === "win32" ? join(venvDir, "Scripts", "python.exe") : join(venvDir, "bin", "python");
}

async function findPythonCommand(signal?: AbortSignal): Promise<{ command: string; args: string[] }> {
  const configured = process.env.MANGA_TRANSLATOR_FLUX_PYTHON ?? process.env.MGT_FLUX_PYTHON;
  const candidates: Array<{ command: string; args: string[] }> = [];
  if (configured) {
    candidates.push({ command: configured, args: [] });
  }
  if (process.platform === "win32") {
    candidates.push({ command: "py", args: ["-3"] }, { command: "python", args: [] });
  } else {
    candidates.push({ command: "python3", args: [] }, { command: "python", args: [] });
  }
  for (const candidate of candidates) {
    try {
      await runCommand(candidate.command, [...candidate.args, "--version"], { signal });
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("Flux Python 런타임을 만들 Python 3 실행 파일을 찾지 못했습니다. Python 3.11 이상을 설치하거나 MGT_FLUX_PYTHON으로 경로를 지정하세요.");
}

function resolveTorchIndexUrl(backend: Exclude<FluxWorkerBackend, "cuda-native">): string {
  if (backend === "python-rocm") {
    return process.env.MANGA_TRANSLATOR_FLUX_ROCM_TORCH_INDEX_URL ?? process.env.MGT_FLUX_ROCM_TORCH_INDEX_URL ?? FLUX_ROCM_TORCH_INDEX_URL;
  }
  return process.env.MANGA_TRANSLATOR_FLUX_CPU_TORCH_INDEX_URL ?? process.env.MGT_FLUX_CPU_TORCH_INDEX_URL ?? FLUX_CPU_TORCH_INDEX_URL;
}

function resolvePythonFluxPackages(backend: Exclude<FluxWorkerBackend, "cuda-native">): string[] {
  return [
    "diffusers>=0.36.0",
    "transformers>=4.56.0",
    "accelerate>=1.10.0",
    "safetensors>=0.6.0",
    "huggingface_hub>=0.36.0",
    "pillow>=10.0.0",
    "sentencepiece>=0.2.0",
    "protobuf>=4.25.0"
  ];
}

function resolveFluxPythonMode(): string {
  const normalized = String(process.env.MANGA_TRANSLATOR_FLUX_PYTHON_MODE ?? process.env.MGT_FLUX_PYTHON_MODE ?? "")
    .trim()
    .toLowerCase();
  return normalized === "flux-fill" ? "flux-fill" : FLUX_PYTHON_DEFAULT_MODE;
}

async function verifyFluxPythonRuntime(
  pythonPath: string,
  backend: Exclude<FluxWorkerBackend, "cuda-native">,
  signal?: AbortSignal
): Promise<void> {
  const verifyScript = [
    "import importlib, torch",
    "for name in ['diffusers','transformers','accelerate','safetensors','PIL','torchvision','sentencepiece','google.protobuf']:",
    "    importlib.import_module(name)",
    backend === "python-rocm" ? "assert getattr(torch.version, 'hip', None), 'installed torch is not a ROCm/HIP build'" : "",
    backend === "python-rocm" ? "assert torch.cuda.is_available(), 'ROCm torch cannot see an AMD GPU'" : "",
    "print('ok')"
  ].filter(Boolean).join("\n");
  await runCommand(pythonPath, ["-c", verifyScript], { signal });
}

async function ensureFluxPythonModelCache(options: {
  pythonPath: string;
  modelDir: string;
  modelId: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<void> {
  const markerPath = join(options.modelDir, ".mgt-flux-diffusers-model.json");
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as { modelId?: string };
    if (marker.modelId === options.modelId) {
      options.onProgress?.({
        progressText: "Flux Diffusers 모델 캐시 사용",
        detail: options.modelId,
        progressMode: "log-only",
        installLogLine: `캐시된 Diffusers Flux 모델을 사용합니다: ${options.modelId}`
      });
      return;
    }
  } catch {
    // Model cache marker is best-effort; snapshot_download below is idempotent.
  }

  await mkdir(options.modelDir, { recursive: true });
  options.onProgress?.({
    progressText: "Flux Diffusers 모델 준비 중",
    detail: options.modelId,
    progressMode: "indeterminate",
    installLogLine: `Diffusers Flux 모델 캐시를 확인합니다: ${options.modelId}`
  });
  const downloadScript = [
    "from huggingface_hub import snapshot_download",
    "import sys",
    "snapshot_download(repo_id=sys.argv[1], cache_dir=sys.argv[2], resume_download=True)"
  ].join("\n");
  await runCommand(options.pythonPath, ["-c", downloadScript, options.modelId, options.modelDir], {
    signal: options.signal,
    env: {
      HF_HOME: options.modelDir,
      HUGGINGFACE_HUB_CACHE: join(options.modelDir, "hub")
    },
    onLine: (line) =>
      options.onProgress?.({
        progressText: "Flux Diffusers 모델 준비 중",
        detail: options.modelId,
        progressMode: "indeterminate",
        installLogLine: line
      })
  });
  await writeFile(markerPath, `${JSON.stringify({ modelId: options.modelId, cachedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

function emitPythonInstallLog(
  options: { onProgress?: (progress: FluxAssetProgress) => void },
  line: string
): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  options.onProgress?.({
    progressText: "Flux Python 런타임 설치 중",
    detail: trimmed.slice(0, 180),
    progressMode: "indeterminate",
    installLogLine: trimmed
  });
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    onLine?: (line: string) => void;
  } = {}
): Promise<void> {
  throwIfAborted(options.signal);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      env: {
        ...process.env,
        ...options.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderrTail = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const emitLines = (text: string, isError = false) => {
      const key = isError ? "stderr" : "stdout";
      let buffer = key === "stderr" ? stderrBuffer : stdoutBuffer;
      buffer += text;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = buffer.slice(0, newline).trimEnd();
        buffer = buffer.slice(newline + 1);
        options.onLine?.(line);
      }
      if (key === "stderr") {
        stderrBuffer = buffer;
      } else {
        stdoutBuffer = buffer;
      }
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      reject(new DOMException("Aborted", "AbortError"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => emitLines(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrTail = `${stderrTail}${text}`.slice(-2400);
      emitLines(text, true);
    });
    child.on("error", (error) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("exit", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed (${code}). ${sanitizeFluxRuntimeStderr(stderrTail).trim()}`));
      }
    });
  });
}

export function hfResolveUrl(repo: string, fileName: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(fileName)}`;
}

export async function ensureRemoteFile(options: {
  modelDir: string;
  url: string;
  fileName: string;
  label: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  const filePath = join(options.modelDir, options.fileName);
  if (await isUsableRemoteFile(filePath, options.url)) {
    options.onProgress?.({
      progressText: `${options.label} 캐시 사용`,
      detail: options.fileName,
      progressMode: "log-only",
      installLogLine: `캐시된 ${options.label} 파일을 사용합니다: ${options.fileName}`
    });
    return filePath;
  }
  await mkdir(options.modelDir, { recursive: true });
  await downloadToFile({
    url: options.url,
    outputPath: filePath,
    signal: options.signal,
    progressText: `${options.label} 다운로드 중`,
    label: options.fileName,
    onProgress: options.onProgress
  });
  return filePath;
}

async function downloadToFile(options: {
  url: string;
  outputPath: string;
  signal?: AbortSignal;
  progressText: string;
  label: string;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<void> {
  if (await isUsableRemoteFile(options.outputPath, options.url)) {
    options.onProgress?.({
      progressText: `${options.label} 캐시 사용`,
      detail: options.label,
      progressMode: "log-only",
      installLogLine: `캐시된 파일을 사용합니다: ${options.label}`
    });
    return;
  }
  await mkdir(dirname(options.outputPath), { recursive: true });
  const partPath = `${options.outputPath}.part`;
  await rm(partPath, { force: true });
  const totalBytes = await probeContentLength(options.url, options.signal);
  options.onProgress?.({
    progressText: options.progressText,
    detail: options.label,
    progressMode: totalBytes > 0 ? "determinate" : "log-only",
    progressPercent: totalBytes > 0 ? 0 : undefined,
    progressBytes: totalBytes > 0 ? 0 : undefined,
    progressTotalBytes: totalBytes > 0 ? totalBytes : undefined,
    installLogLine: `${options.label} 다운로드 시작`
  });

  const response = await fetch(options.url, {
    signal: options.signal,
    headers: { "User-Agent": "manga-gemma-translator" }
  });
  if (!response.ok || !response.body) {
    throw new Error(`${options.label} 다운로드에 실패했습니다 (${response.status}).`);
  }

  const responseTotalBytes = totalBytes || readContentLength(response);
  const reader = response.body.getReader();
  const writer = createWriteStream(partPath, { flags: "wx" });
  let receivedBytes = 0;
  let lastEmitAt = 0;
  try {
    while (true) {
      throwIfAborted(options.signal);
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = Buffer.from(value);
      await writeStreamChunk(writer, chunk);
      receivedBytes += chunk.byteLength;
      const now = Date.now();
      if (now - lastEmitAt > 500) {
        lastEmitAt = now;
        emitDownloadProgress(options, receivedBytes, responseTotalBytes);
      }
    }
    await finishWriteStream(writer);
    if (responseTotalBytes > 0 && receivedBytes !== responseTotalBytes) {
      throw new Error(`${options.label} 다운로드 크기가 맞지 않습니다 (${formatBytes(receivedBytes)} / ${formatBytes(responseTotalBytes)}).`);
    }
    await rm(options.outputPath, { force: true });
    await rename(partPath, options.outputPath);
    await writeRemoteFileMetadata(options.outputPath, {
      url: options.url,
      bytes: receivedBytes,
      downloadedAt: new Date().toISOString()
    });
    emitDownloadProgress(options, responseTotalBytes > 0 ? responseTotalBytes : receivedBytes, responseTotalBytes || receivedBytes, true);
  } catch (error) {
    writer.destroy();
    await rm(partPath, { force: true }).catch(() => {});
    throw error;
  }
}

function emitDownloadProgress(
  options: {
    progressText: string;
    label: string;
    onProgress?: (progress: FluxAssetProgress) => void;
  },
  receivedBytes: number,
  totalBytes: number,
  done = false
): void {
  options.onProgress?.({
    progressText: done ? `${options.label} 다운로드 완료` : options.progressText,
    detail: totalBytes > 0 ? `${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}` : `${formatBytes(receivedBytes)} 받음`,
    progressMode: totalBytes > 0 ? "determinate" : "log-only",
    progressPercent: totalBytes > 0 ? Math.min(1, receivedBytes / totalBytes) : undefined,
    progressBytes: totalBytes > 0 ? receivedBytes : undefined,
    progressTotalBytes: totalBytes > 0 ? totalBytes : undefined,
    installLogLine:
      totalBytes > 0
        ? `${options.label}: ${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`
        : `${options.label}: ${formatBytes(receivedBytes)}`
  });
}

function findFirstExecutable(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate && isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isUsableFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile() && statSync(filePath).size > 1024 * 1024;
  } catch {
    return false;
  }
}

async function isUsableRemoteFile(filePath: string, url: string): Promise<boolean> {
  if (!isUsableFile(filePath)) {
    return false;
  }
  const metadata = await readRemoteFileMetadata(filePath);
  if (!metadata) {
    return true;
  }
  try {
    const actualBytes = statSync(filePath).size;
    return metadata.url === url && metadata.bytes === actualBytes && actualBytes > 1024 * 1024;
  } catch {
    return false;
  }
}

async function readRemoteFileMetadata(filePath: string): Promise<RemoteFileMetadata | null> {
  try {
    return JSON.parse(await readFile(remoteFileMetadataPath(filePath), "utf8")) as RemoteFileMetadata;
  } catch {
    return null;
  }
}

async function writeRemoteFileMetadata(filePath: string, metadata: RemoteFileMetadata): Promise<void> {
  await writeFile(remoteFileMetadataPath(filePath), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function remoteFileMetadataPath(filePath: string): string {
  return `${filePath}.mgtmeta.json`;
}

function isExecutableFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

async function probeContentLength(url: string, signal?: AbortSignal): Promise<number> {
  try {
    const response = await fetch(url, { method: "HEAD", signal });
    return response.ok ? readContentLength(response) : 0;
  } catch {
    return 0;
  }
}

function readContentLength(response: Response): number {
  const value = Number(response.headers.get("content-length"));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function writeStreamChunk(writer: ReturnType<typeof createWriteStream>, chunk: Buffer): Promise<void> {
  if (writer.write(chunk)) {
    return;
  }
  await once(writer, "drain");
}

async function finishWriteStream(writer: ReturnType<typeof createWriteStream>): Promise<void> {
  writer.end();
  await once(writer, "finish");
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
