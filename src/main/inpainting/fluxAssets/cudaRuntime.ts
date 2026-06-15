import { statSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  FLUX_RUNNER_DIR,
  FLUX_RUNTIME_EXECUTABLE,
} from "./constants";
import type { FluxAssetProgress, NvidiaRedistPackage } from "./types";
import {
  downloadRuntimeArchive,
  extractSelectedZipEntries,
  readJsonUrl,
  readNvidiaRedistPackage,
} from "./downloads";
import {
  findFirstExecutable,
  isExecutableFile,
  sha256FileSync,
} from "./fileProbe";
import { throwIfAborted } from "./errors";

export async function ensureManagedFluxRunner(options: {
  runtimeDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  const managedDir = join(options.runtimeDir, FLUX_RUNNER_DIR);
  const managedPath = join(managedDir, FLUX_RUNTIME_EXECUTABLE);

  const source = findFirstExecutable([
    process.env.MGT_FLUX_KLEIN_EXE,
    process.resourcesPath
      ? join(
          process.resourcesPath,
          "tools",
          FLUX_RUNNER_DIR,
          FLUX_RUNTIME_EXECUTABLE,
        )
      : undefined,
    join(process.cwd(), "tools", FLUX_RUNNER_DIR, FLUX_RUNTIME_EXECUTABLE),
  ]);
  if (!source) {
    throw new Error(
      `${FLUX_RUNTIME_EXECUTABLE}를 찾지 못했습니다. 설치 파일에 Flux Klein 실행 파일이 포함되어 있어야 합니다. ` +
        `개발 환경에서는 node scripts/prepare-flux-klein-runner.cjs를 실행하거나 MGT_FLUX_KLEIN_EXE로 경로를 지정하세요.`,
    );
  }

  throwIfAborted(options.signal);
  await mkdir(managedDir, { recursive: true });
  if (
    isExecutableFile(managedPath) &&
    sha256FileSync(managedPath) === sha256FileSync(source)
  ) {
    return managedPath;
  }
  await copyFile(source, managedPath);
  options.onProgress?.({
    progressText: "Flux 실행 파일 준비 중",
    detail: FLUX_RUNTIME_EXECUTABLE,
    progressMode: "log-only",
    installLogLine: `Flux 실행 파일을 앱 데이터 캐시에 갱신했습니다: ${FLUX_RUNTIME_EXECUTABLE}`,
  });
  return managedPath;
}

export async function ensureFluxCudaRuntime(options: {
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
      installLogLine: "캐시된 Flux CUDA/cuDNN 런타임을 사용합니다.",
    });
    return;
  }

  await rm(cudaDir, { recursive: true, force: true });
  await mkdir(cudaDir, { recursive: true });
  const downloadsDir = join(options.runtimeDir, ".downloads");
  await mkdir(downloadsDir, { recursive: true });

  const cudaManifest = await readJsonUrl(
    CUDA_REDIST_MANIFEST_URL,
    options.signal,
  );
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

  const cudnnManifest = await readJsonUrl(
    CUDNN_REDIST_MANIFEST_URL,
    options.signal,
  );
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

  for (const entry of cudaPackages) {
    const archivePath = await downloadRuntimeArchive({
      ...options,
      downloadsDir,
      entry,
      baseUrl: CUDA_REDIST_BASE_URL,
      label: "Flux CUDA 런타임",
    });
    extractSelectedZipEntries(archivePath, cudaDir, (fileName) =>
      FLUX_CUDA_DLLS.has(fileName),
    );
  }

  const cudnnArchivePath = await downloadRuntimeArchive({
    ...options,
    downloadsDir,
    entry: cudnnPackage,
    baseUrl: CUDNN_REDIST_BASE_URL,
    label: "Flux cuDNN 런타임",
  });
  extractSelectedZipEntries(cudnnArchivePath, cudaDir, (fileName) =>
    FLUX_CUDNN_DLLS.has(fileName),
  );

  if (!(await hasFluxCudaRuntimeFiles(cudaDir))) {
    throw new Error("Flux CUDA/cuDNN 런타임 설치가 완료되지 않았습니다.");
  }
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
