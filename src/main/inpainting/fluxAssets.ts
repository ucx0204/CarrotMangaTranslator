import { once } from "node:events";
import { createWriteStream, existsSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const AdmZip = require("adm-zip");

export const FLUX_RUNTIME_EXECUTABLE = "mgt-flux-klein.exe";
export const FLUX_MODEL_REPO = "unsloth/FLUX.2-klein-4B-GGUF";
export const FLUX_MODEL_FILE = "flux-2-klein-4b-Q4_K_M.gguf";
export const FLUX_VAE_REPO = "black-forest-labs/FLUX.2-small-decoder";
export const FLUX_VAE_FILE = "diffusion_pytorch_model.safetensors";
const FLUX_RUNNER_DIR = "mgt-flux-klein";
const FLUX_CUDA_RUNTIME_DIR = "mgt-flux-cuda12.9";
const FLUX_CUDA_RUNTIME_MARKER = ".mgt-runtime.json";
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
  const cudaPackages = [
    cudaManifest?.libcublas?.["windows-x86_64"],
    cudaManifest?.cuda_cudart?.["windows-x86_64"],
    cudaManifest?.libcurand?.["windows-x86_64"]
  ].filter(Boolean);
  if (cudaPackages.length !== 3) {
    throw new Error("NVIDIA CUDA 12.9 런타임 목록에서 필요한 DLL 패키지를 찾지 못했습니다.");
  }

  const cudnnManifest = await readJsonUrl(CUDNN_REDIST_MANIFEST_URL, options.signal);
  const cudnnPackage = cudnnManifest?.cudnn?.["windows-x86_64"]?.cuda12;
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

async function readJsonUrl(url: string, signal?: AbortSignal): Promise<any> {
  throwIfAborted(signal);
  const response = await fetch(url, { signal, headers: { "User-Agent": "manga-gemma-translator" } });
  if (!response.ok) {
    throw new Error(`${url} 요청에 실패했습니다 (${response.status}).`);
  }
  return response.json();
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

function findExecutable(rootDir: string, executableNames: string[]): string | null {
  if (!existsSync(rootDir)) {
    return null;
  }
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(path);
      } else if (stat.isFile() && executableNames.some((name) => entry.toLowerCase() === name.toLowerCase())) {
        return path;
      }
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
