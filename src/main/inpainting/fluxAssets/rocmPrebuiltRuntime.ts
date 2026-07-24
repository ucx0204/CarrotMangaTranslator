import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  FLUX_EMBED_PYTHON_VERSION,
  FLUX_ROCM_PREBUILT_RUNTIME_FILE,
  FLUX_ROCM_PREBUILT_RUNTIME_MANIFEST,
  FLUX_ROCM_PREBUILT_RUNTIME_SCHEMA,
  FLUX_ROCM_WINDOWS_VERSION,
} from "./constants";
import type {
  FluxAssetProgress,
  FluxPythonBackend,
  FluxPythonRuntime,
  FluxPythonRuntimeLayout,
} from "./types";
import { downloadToFile, extractLargeZipSafely } from "./downloads";
import { isExecutableFile, isUsableFile } from "./fileProbe";
import {
  resolveFluxRocmPrebuiltRuntimeUrl,
  shouldUsePrebuiltFluxRocmRuntime,
} from "./manifests";
import { managedFluxBootstrapPythonPath } from "./pythonBootstrap";
import { ensureEmbeddedPythonPackagePath } from "./pythonPathFile";
import { buildTargetPythonEnv } from "./rocmRuntime";
import { ensureFluxPythonWorker } from "./pythonRuntimeLayout";
import {
  hasUsablePackageDir,
  verifyFluxPythonRuntime,
} from "./pythonRuntimePackages";

type PrebuiltFluxRocmRuntimeOptions = {
  layout: FluxPythonRuntimeLayout;
  expectedMarker: {
    backend: FluxPythonBackend;
    runtimeInstallBatches: Array<{ id: string; pipArgs: string[] }>;
    buildPackages: string[];
    packages: string[];
    worker: string;
    workerHash: string;
  };
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
};

type PrebuiltArchiveInfo = {
  archiveName: string;
  archivePath: string;
  archiveUrl: string;
};

export async function ensurePrebuiltFluxRocmPythonRuntime(
  options: PrebuiltFluxRocmRuntimeOptions,
): Promise<FluxPythonRuntime | null> {
  const archiveUrl = resolveFluxRocmPrebuiltRuntimeUrl();
  if (!archiveUrl || !shouldUsePrebuiltFluxRocmRuntime()) {
    return null;
  }

  const archiveInfo = await resolvePrebuiltFluxRocmArchive(options, archiveUrl);
  await extractPrebuiltFluxRocmRuntime(options, archiveInfo.archivePath);
  const pythonRuntime = buildPrebuiltFluxRocmPythonRuntime(options);
  await verifyFluxPythonRuntime(pythonRuntime, "python-rocm", options.signal);
  await writePrebuiltFluxRocmMarker(options, archiveInfo, pythonRuntime);
  reportPrebuiltFluxRocmReady(options, archiveInfo.archiveName);
  return pythonRuntime;
}

async function resolvePrebuiltFluxRocmArchive(
  options: PrebuiltFluxRocmRuntimeOptions,
  archiveUrl: string,
): Promise<PrebuiltArchiveInfo> {
  const archiveName = resolveArchiveFileName(
    archiveUrl,
    FLUX_ROCM_PREBUILT_RUNTIME_FILE,
  );
  options.onProgress?.({
    progressText: "Flux ROCm prebuilt 런타임 준비 중",
    detail: archiveName,
    progressMode: "log-only",
    installLogLine: `Flux ROCm prebuilt 런타임을 사용합니다: ${archiveName}`,
  });
  const archivePath = await ensurePrebuiltFluxRocmRuntimeArchive({
    urlOrPath: archiveUrl,
    outputPath: join(
      dirname(options.layout.runtimeDir),
      ".downloads",
      archiveName,
    ),
    signal: options.signal,
    label: archiveName,
    onProgress: options.onProgress,
  });
  return { archiveName, archivePath, archiveUrl };
}

async function extractPrebuiltFluxRocmRuntime(
  options: PrebuiltFluxRocmRuntimeOptions,
  archivePath: string,
): Promise<void> {
  await rm(options.layout.runtimeDir, { recursive: true, force: true });
  await mkdir(options.layout.runtimeDir, { recursive: true });
  await extractLargeZipSafely(archivePath, options.layout.runtimeDir);
  await ensureFluxPythonWorker(
    options.layout.runtimeDir,
    options.expectedMarker.worker,
  );
  await validatePrebuiltFluxRocmRuntime(options.layout.runtimeDir);
}

function buildPrebuiltFluxRocmPythonRuntime(
  options: PrebuiltFluxRocmRuntimeOptions,
): FluxPythonRuntime {
  const pythonPath = managedFluxBootstrapPythonPath(options.layout.runtimeDir);
  assertPrebuiltFluxRocmPythonRuntimeFiles(options, pythonPath);
  ensureEmbeddedPythonPackagePath(pythonPath, options.layout.packageDir);
  return {
    mode: "target",
    command: pythonPath,
    executable: pythonPath,
    args: [],
    env: buildTargetPythonEnv(
      options.layout.runtimeDir,
      options.layout.packageDir,
      "python-rocm",
    ),
    packageDir: options.layout.packageDir,
  };
}

function assertPrebuiltFluxRocmPythonRuntimeFiles(
  options: PrebuiltFluxRocmRuntimeOptions,
  pythonPath: string,
): void {
  if (!isExecutableFile(pythonPath)) {
    throw new Error(
      `Flux ROCm prebuilt 런타임에 Python 실행 파일이 없습니다: ${pythonPath}`,
    );
  }
  if (!hasUsablePackageDir(options.layout.packageDir, "python-rocm")) {
    throw new Error(
      `Flux ROCm prebuilt 런타임에 필요한 Python 패키지가 없습니다: ${options.layout.packageDir}`,
    );
  }
}

async function writePrebuiltFluxRocmMarker(
  options: PrebuiltFluxRocmRuntimeOptions,
  archiveInfo: PrebuiltArchiveInfo,
  pythonRuntime: FluxPythonRuntime,
): Promise<void> {
  await writeFile(
    options.layout.markerPath,
    `${JSON.stringify(
      {
        ...options.expectedMarker,
        runtimeMode: "target",
        pythonPath: pythonRuntime.executable,
        packageDir: pythonRuntime.packageDir,
        prebuiltRuntimeUrl: archiveInfo.archiveUrl,
        prebuiltRuntimeFile: archiveInfo.archiveName,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function reportPrebuiltFluxRocmReady(
  options: PrebuiltFluxRocmRuntimeOptions,
  archiveName: string,
): void {
  options.onProgress?.({
    progressText: "Flux ROCm prebuilt 런타임 준비 완료",
    detail: archiveName,
    progressMode: "log-only",
    installLogLine: "Flux ROCm prebuilt 런타임 검증이 완료되었습니다.",
  });
}

async function ensurePrebuiltFluxRocmRuntimeArchive(options: {
  urlOrPath: string;
  outputPath: string;
  signal?: AbortSignal;
  label: string;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  const parsed = parseMaybeUrl(options.urlOrPath);
  if (parsed && ["http:", "https:"].includes(parsed.protocol)) {
    await downloadToFile({
      url: options.urlOrPath,
      outputPath: options.outputPath,
      signal: options.signal,
      progressText: "Flux ROCm prebuilt 런타임 다운로드 중",
      label: options.label,
      onProgress: options.onProgress,
    });
    return options.outputPath;
  }

  const sourcePath =
    parsed?.protocol === "file:"
      ? decodeURIComponent(parsed.pathname)
      : options.urlOrPath;
  const normalizedSourcePath =
    process.platform === "win32" &&
    sourcePath.startsWith("/") &&
    /^[A-Za-z]:/.test(sourcePath.slice(1))
      ? sourcePath.slice(1)
      : sourcePath;
  if (!isUsableFile(normalizedSourcePath)) {
    throw new Error(
      `Flux ROCm prebuilt 런타임 파일을 찾지 못했습니다: ${options.urlOrPath}`,
    );
  }
  await mkdir(dirname(options.outputPath), { recursive: true });
  await copyFile(normalizedSourcePath, options.outputPath);
  options.onProgress?.({
    progressText: "Flux ROCm prebuilt 런타임 파일 복사 완료",
    detail: basename(normalizedSourcePath),
    progressMode: "log-only",
    installLogLine: `로컬 Flux ROCm prebuilt 런타임을 사용합니다: ${normalizedSourcePath}`,
  });
  return options.outputPath;
}

function resolveArchiveFileName(urlOrPath: string, fallback: string): string {
  const parsed = parseMaybeUrl(urlOrPath);
  if (parsed) {
    return basename(decodeURIComponent(parsed.pathname)) || fallback;
  }
  return basename(urlOrPath) || fallback;
}

function parseMaybeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch (_error) {
    return null;
  }
}

async function validatePrebuiltFluxRocmRuntime(
  runtimeDir: string,
): Promise<void> {
  const manifestPath = join(runtimeDir, FLUX_ROCM_PREBUILT_RUNTIME_MANIFEST);
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Flux ROCm prebuilt manifest를 읽지 못했습니다: ${manifestPath}. ${message}`,
      { cause: error },
    );
  }
  const schemaVersion = Number(manifest.schemaVersion);
  if (schemaVersion !== FLUX_ROCM_PREBUILT_RUNTIME_SCHEMA) {
    throw new Error(
      `Flux ROCm prebuilt manifest 버전이 맞지 않습니다 (${manifest.schemaVersion}).`,
    );
  }
  if (manifest.backend !== "python-rocm") {
    throw new Error(
      `Flux ROCm prebuilt manifest backend가 맞지 않습니다 (${String(manifest.backend)}).`,
    );
  }
  if (manifest.rocmVersion !== FLUX_ROCM_WINDOWS_VERSION) {
    throw new Error(
      `Flux ROCm prebuilt ROCm 버전이 맞지 않습니다 (${String(manifest.rocmVersion)}).`,
    );
  }
  if (manifest.pythonVersion !== FLUX_EMBED_PYTHON_VERSION) {
    throw new Error(
      `Flux ROCm prebuilt Python 버전이 맞지 않습니다 (${String(manifest.pythonVersion)}).`,
    );
  }
}
