import { statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CUDA_REDIST_BASE_URL,
  CUDA_REDIST_MANIFEST_URL,
  CUDNN_REDIST_BASE_URL,
  CUDNN_REDIST_MANIFEST_URL,
  FLUX_CUDA_DLLS,
  FLUX_CUDA_RUNTIME_DIR,
  FLUX_CUDA_RUNTIME_MARKER,
  FLUX_CUDNN_DLLS,
} from "./constants";
import type { FluxAssetProgress, NvidiaRedistPackage } from "./types";
import {
  downloadRuntimeArchive,
  extractSelectedZipEntries,
  readJsonUrl,
  readNvidiaRedistPackage,
} from "./downloads";
import {
  createRuntimeStagingDirectory,
  replaceDirectoryWithRollback,
} from "../../runtimeSupport/runtimeDirectoryPublish";

type EnsureFluxCudaRuntimeOptions = {
  runtimeDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
};

export async function ensureFluxCudaRuntime(
  options: EnsureFluxCudaRuntimeOptions,
): Promise<void> {
  const cudaDir = join(options.runtimeDir, FLUX_CUDA_RUNTIME_DIR);
  if (await isCurrentFluxCudaRuntime(cudaDir)) {
    reportCachedFluxCudaRuntime(options);
    return;
  }

  const stagingDir = createRuntimeStagingDirectory(cudaDir);
  const downloadsDir = await prepareFluxCudaRuntimeDirs(options, stagingDir);
  try {
    await installFluxCudaPackages(
      options,
      downloadsDir,
      stagingDir,
      await resolveCudaRedistPackages(options.signal),
    );
    await installFluxCudnnPackage(
      options,
      downloadsDir,
      stagingDir,
      await resolveCudnnRedistPackage(options.signal),
    );
    if (!(await hasFluxCudaRuntimeFiles(stagingDir))) {
      throw new Error("Flux CUDA/cuDNN 런타임 설치가 완료되지 않았습니다.");
    }
    await writeFluxCudaRuntimeMarker(stagingDir);
    await replaceDirectoryWithRollback(stagingDir, cudaDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
  reportInstalledFluxCudaRuntime(options);
}

function reportCachedFluxCudaRuntime(
  options: EnsureFluxCudaRuntimeOptions,
): void {
  options.onProgress?.({
    progressText: "Flux CUDA 런타임 캐시 사용",
    detail: FLUX_CUDA_RUNTIME_DIR,
    progressMode: "log-only",
    installLogLine: "캐시된 Flux CUDA/cuDNN 런타임을 사용합니다.",
  });
}

async function prepareFluxCudaRuntimeDirs(
  options: EnsureFluxCudaRuntimeOptions,
  stagingDir: string,
): Promise<string> {
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  const downloadsDir = join(options.runtimeDir, ".downloads");
  await mkdir(downloadsDir, { recursive: true });
  return downloadsDir;
}

async function resolveCudaRedistPackages(
  signal: AbortSignal | undefined,
): Promise<NvidiaRedistPackage[]> {
  const cudaManifest = await readJsonUrl(CUDA_REDIST_MANIFEST_URL, signal);
  const cudaPackages: NvidiaRedistPackage[] = [
    readNvidiaRedistPackage(cudaManifest, "libcublas", "windows-x86_64"),
    readNvidiaRedistPackage(cudaManifest, "cuda_cudart", "windows-x86_64"),
    readNvidiaRedistPackage(cudaManifest, "libcurand", "windows-x86_64"),
  ].filter((entry): entry is NvidiaRedistPackage => Boolean(entry));
  if (cudaPackages.length !== 3) {
    throw new Error(
      "NVIDIA CUDA 12.9 런타임 목록에서 필요한 DLL 패키지를 찾지 못했습니다.",
    );
  }
  return cudaPackages;
}

async function resolveCudnnRedistPackage(
  signal: AbortSignal | undefined,
): Promise<NvidiaRedistPackage> {
  const cudnnManifest = await readJsonUrl(CUDNN_REDIST_MANIFEST_URL, signal);
  const cudnnPackage = readNvidiaRedistPackage(
    cudnnManifest,
    "cudnn",
    "windows-x86_64",
    "cuda12",
  );
  if (!cudnnPackage) {
    throw new Error(
      "NVIDIA cuDNN 9.21 CUDA 12 런타임 패키지를 찾지 못했습니다.",
    );
  }
  return cudnnPackage;
}

async function installFluxCudaPackages(
  options: EnsureFluxCudaRuntimeOptions,
  downloadsDir: string,
  stagingDir: string,
  cudaPackages: NvidiaRedistPackage[],
): Promise<void> {
  for (const entry of cudaPackages) {
    const archivePath = await downloadRuntimeArchive({
      ...options,
      downloadsDir,
      entry,
      baseUrl: CUDA_REDIST_BASE_URL,
      label: "Flux CUDA 런타임",
    });
    await extractFluxCudaRuntimeArchiveToStaging({
      archivePath,
      runtimeDir: options.runtimeDir,
      selectedFileNames: FLUX_CUDA_DLLS,
      signal: options.signal,
      stagingDir,
    });
  }
}

async function installFluxCudnnPackage(
  options: EnsureFluxCudaRuntimeOptions,
  downloadsDir: string,
  stagingDir: string,
  cudnnPackage: NvidiaRedistPackage,
): Promise<void> {
  const cudnnArchivePath = await downloadRuntimeArchive({
    ...options,
    downloadsDir,
    entry: cudnnPackage,
    baseUrl: CUDNN_REDIST_BASE_URL,
    label: "Flux cuDNN 런타임",
  });
  await extractFluxCudaRuntimeArchiveToStaging({
    archivePath: cudnnArchivePath,
    runtimeDir: options.runtimeDir,
    selectedFileNames: FLUX_CUDNN_DLLS,
    signal: options.signal,
    stagingDir,
  });
}

/**
 * Extracts one pinned CUDA archive into the shared staging directory. Keeping
 * the final path derivation here prevents an archive caller from accidentally
 * validating only the shorter staging path.
 */
export async function extractFluxCudaRuntimeArchiveToStaging(options: {
  archivePath: string;
  runtimeDir: string;
  selectedFileNames: ReadonlySet<string>;
  signal?: AbortSignal;
  stagingDir: string;
}): Promise<void> {
  await extractSelectedZipEntries(
    options.archivePath,
    options.stagingDir,
    (fileName) => options.selectedFileNames.has(fileName),
    options.signal,
    false,
    join(options.runtimeDir, FLUX_CUDA_RUNTIME_DIR),
  );
}

async function writeFluxCudaRuntimeMarker(cudaDir: string): Promise<void> {
  await writeFile(
    runtimeMarkerPath(cudaDir),
    `${JSON.stringify(
      {
        cudaManifest: CUDA_REDIST_MANIFEST_URL,
        cudnnManifest: CUDNN_REDIST_MANIFEST_URL,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function reportInstalledFluxCudaRuntime(
  options: EnsureFluxCudaRuntimeOptions,
): void {
  options.onProgress?.({
    progressText: "Flux CUDA 런타임 설치 완료",
    detail: FLUX_CUDA_RUNTIME_DIR,
    progressMode: "determinate",
    progressPercent: 1,
    installLogLine: "Flux CUDA/cuDNN 런타임 준비가 완료되었습니다.",
  });
}

async function isCurrentFluxCudaRuntime(cudaDir: string): Promise<boolean> {
  try {
    const marker = JSON.parse(
      await readFile(runtimeMarkerPath(cudaDir), "utf8"),
    ) as { cudnnManifest?: string };
    return (
      marker?.cudnnManifest === CUDNN_REDIST_MANIFEST_URL &&
      (await hasFluxCudaRuntimeFiles(cudaDir))
    );
  } catch (_error) {
    return false;
  }
}

async function hasFluxCudaRuntimeFiles(cudaDir: string): Promise<boolean> {
  return [...FLUX_CUDA_DLLS, ...FLUX_CUDNN_DLLS].every((fileName) => {
    try {
      return statSync(join(cudaDir, fileName)).size > 0;
    } catch (_error) {
      return false;
    }
  });
}

export function runtimeMarkerPath(cudaDir: string): string {
  return join(cudaDir, FLUX_CUDA_RUNTIME_MARKER);
}
