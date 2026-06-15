import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  FLUX_PYTHON_RUNTIME_MARKER,
  FLUX_PYTHON_WORKER,
  FLUX_ROCM_WINDOWS_VERSION,
  FLUX_SDCPP_WORKER,
  ROCM_LONGEST_FINAL_ENTRY,
  ROCM_LONGEST_PIP_TEMP_ENTRY,
  WINDOWS_LEGACY_MAX_PATH,
  WINDOWS_PATH_SAFETY_MARGIN,
  resolveFluxRuntimeTempDir,
} from "./constants";
import type {
  FluxPythonBackend,
  FluxPythonRuntime,
  FluxPythonRuntimeLayout,
} from "./types";
import {
  ensureEmbeddedPythonPackagePath,
  managedFluxBootstrapPythonPath,
} from "./pythonBootstrap";
import { buildTargetPythonEnv } from "./rocmRuntime";
import { hasUsablePackageDir } from "./pythonRuntimePackages";
import { isExecutableFile, sha256FileSync } from "./fileProbe";

export function resolveFluxPythonRuntimeLayout(
  baseRuntimeDir: string,
  backend: FluxPythonBackend,
): FluxPythonRuntimeLayout {
  const runtimeName =
    backend === "python-rocm" ? "mgt-flux-python-rocm" : "mgt-flux-python-cpu";
  const useShortRocmLayout =
    backend === "python-rocm" && process.platform === "win32";
  const runtimeDir = useShortRocmLayout
    ? resolveWindowsRocmFluxRuntimeDir(baseRuntimeDir)
    : join(baseRuntimeDir, runtimeName);
  const venvDir = useShortRocmLayout
    ? join(runtimeDir, "v")
    : join(runtimeDir, ".venv");
  const packageDir = useShortRocmLayout
    ? join(runtimeDir, "p")
    : join(runtimeDir, "python-packages");
  const workerFile = resolveFluxPythonWorkerFile(backend);
  return {
    runtimeName,
    runtimeDir,
    venvDir,
    venvPythonPath: pythonExecutablePath(venvDir),
    packageDir,
    workerPath: join(runtimeDir, workerFile),
    markerPath: join(runtimeDir, FLUX_PYTHON_RUNTIME_MARKER),
    tempDir: resolveFluxRuntimeTempDir(runtimeDir),
  };
}

function resolveWindowsRocmFluxRuntimeDir(baseRuntimeDir: string): string {
  const configured =
    process.env.MANGA_TRANSLATOR_FLUX_ROCM_RUNTIME_DIR ??
    process.env.MGT_FLUX_ROCM_RUNTIME_DIR;
  if (configured?.trim()) {
    return resolve(configured.trim());
  }

  const rocmDirName = `r${FLUX_ROCM_WINDOWS_VERSION.replace(/\D/g, "")}`;
  const dataRoot = resolve(baseRuntimeDir, "..", "..", "..");
  const dataRootCandidate = join(dataRoot, "fx", rocmDirName);
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const localCandidate = localAppData
    ? join(localAppData, "MGTFlux", rocmDirName)
    : null;
  const candidates = [dataRootCandidate, localCandidate].filter(
    (candidate): candidate is string => Boolean(candidate),
  );

  const dataRootIsSafe = isRocmRuntimePathShortEnough(dataRootCandidate);
  if (dataRootIsSafe) {
    return dataRootCandidate;
  }
  const localIsSafe = localCandidate
    ? isRocmRuntimePathShortEnough(localCandidate)
    : false;
  if (localCandidate && localIsSafe) {
    return localCandidate;
  }
  return candidates.sort((a, b) => a.length - b.length)[0] ?? dataRootCandidate;
}

function isRocmRuntimePathShortEnough(runtimeDir: string): boolean {
  const longestRuntimePath = Math.max(
    join(runtimeDir, ROCM_LONGEST_FINAL_ENTRY).length,
    join(runtimeDir, ROCM_LONGEST_PIP_TEMP_ENTRY).length,
  );
  return (
    longestRuntimePath < WINDOWS_LEGACY_MAX_PATH - WINDOWS_PATH_SAFETY_MARGIN
  );
}

export function resolveFluxPythonWorkerFile(
  backend: FluxPythonBackend,
): string {
  return backend === "python-rocm" ? FLUX_SDCPP_WORKER : FLUX_PYTHON_WORKER;
}

export async function ensureFluxPythonWorker(
  runtimeDir: string,
  workerFile: string,
): Promise<string> {
  await mkdir(runtimeDir, { recursive: true });
  const workerPath = join(runtimeDir, workerFile);
  const sourceWorker = findFluxPythonWorkerSource(workerFile);
  if (!sourceWorker) {
    throw new Error(
      `${workerFile}를 찾지 못했습니다. 앱 런타임 파일을 다시 준비하세요.`,
    );
  }
  if (
    isExecutableFile(workerPath) &&
    sha256FileSync(workerPath) === sha256FileSync(sourceWorker)
  ) {
    return workerPath;
  }
  await copyFile(sourceWorker, workerPath);
  return workerPath;
}

export function findFluxPythonWorkerSource(workerFile: string): string | null {
  const candidates = [
    process.resourcesPath
      ? join(process.resourcesPath, "app-runtime", workerFile)
      : undefined,
    join(process.cwd(), "out", "app-runtime", workerFile),
    join(process.cwd(), "src", "main", "runtime", workerFile),
  ];
  for (const candidate of candidates) {
    if (candidate && isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function resolveCurrentFluxPythonRuntime(options: {
  runtimeDir: string;
  venvPythonPath: string;
  packageDir: string;
  markerPath: string;
  expectedMarker: {
    backend: FluxPythonBackend;
    runtimeInstallBatches: Array<{ id: string; pipArgs: string[] }>;
    buildPackages: string[];
    packages: string[];
    worker: string;
    workerHash: string;
  };
}): Promise<FluxPythonRuntime | null> {
  try {
    if (
      !isExecutableFile(
        join(dirname(options.markerPath), options.expectedMarker.worker),
      )
    ) {
      return null;
    }
    const marker = JSON.parse(
      await readFile(options.markerPath, "utf8"),
    ) as Partial<typeof options.expectedMarker> & {
      runtimeMode?: "venv" | "target";
      pythonPath?: string;
      packageDir?: string;
    };
    if (
      marker.backend !== options.expectedMarker.backend ||
      JSON.stringify(marker.runtimeInstallBatches ?? null) !==
        JSON.stringify(options.expectedMarker.runtimeInstallBatches) ||
      JSON.stringify(marker.buildPackages ?? null) !==
        JSON.stringify(options.expectedMarker.buildPackages) ||
      JSON.stringify(marker.packages ?? null) !==
        JSON.stringify(options.expectedMarker.packages) ||
      marker.worker !== options.expectedMarker.worker ||
      marker.workerHash !== options.expectedMarker.workerHash
    ) {
      return null;
    }
    if (marker.runtimeMode !== "target") {
      return null;
    }
    const pythonPath =
      typeof marker.pythonPath === "string"
        ? marker.pythonPath
        : managedFluxBootstrapPythonPath(options.runtimeDir);
    const packageDir =
      typeof marker.packageDir === "string"
        ? marker.packageDir
        : options.packageDir;
    if (
      !isExecutableFile(pythonPath) ||
      !hasUsablePackageDir(packageDir, options.expectedMarker.backend)
    ) {
      return null;
    }
    if (isAbsolute(pythonPath)) {
      ensureEmbeddedPythonPackagePath(pythonPath, packageDir);
    }
    return {
      mode: "target",
      command: pythonPath,
      executable: pythonPath,
      args: [],
      env: buildTargetPythonEnv(
        options.runtimeDir,
        packageDir,
        options.expectedMarker.backend,
      ),
      packageDir,
    };
  } catch (_error) {
    return null;
  }
}

function pythonExecutablePath(venvDir: string): string {
  return process.platform === "win32"
    ? join(venvDir, "Scripts", "python.exe")
    : join(venvDir, "bin", "python");
}
