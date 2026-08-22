import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join, normalize } from "node:path";
import {
  FLUX_BOOTSTRAP_PYTHON_MARKER,
  FLUX_EMBED_PYTHON_VERSION,
  FLUX_GET_PIP_URL,
  resolveFluxRuntimeTempDir,
} from "./constants";
import type { FluxAssetProgress, PythonCommand } from "./types";
import { extractZipSafely } from "./downloads";
import { downloadToFile } from "../../runtimeSupport/modelDownloads";
import {
  MAX_REMOTE_RUNTIME_ARCHIVE_BYTES,
  MAX_REMOTE_SUPPORT_ASSET_BYTES,
} from "../../runtimeSupport/downloadBudgets";
import { runCommand } from "./errors";
import { emitPythonInstallLog } from "./progress";
import { isExecutableFile } from "../../runtimeSupport/fileProbe";
import { sanitizeStandaloneEmbeddedPythonPathFile } from "./pythonPathFile";
import {
  RUNTIME_INTEGRITY_MANIFEST,
  resolvePinnedRemoteAsset,
} from "../../runtimeSupport/runtimeIntegrity";

const { buildIsolatedPipEnvironment } =
  require("../../runtime/python-pip-environment.cjs") as {
    buildIsolatedPipEnvironment: (
      baseEnv?: NodeJS.ProcessEnv,
      managedPipEnv?: NodeJS.ProcessEnv,
    ) => NodeJS.ProcessEnv;
  };

type PythonBootstrapOptions = {
  runtimeDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
};

type ManagedBootstrapPythonConfig = {
  version: string;
  pythonUrl: string;
  pythonSha256: string;
  getPipUrl: string;
  getPipSha256: string;
};

export async function findPythonCommand(options: {
  runtimeDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<PythonCommand> {
  const configured =
    process.env.MANGA_TRANSLATOR_FLUX_PYTHON ?? process.env.MGT_FLUX_PYTHON;
  const candidates: PythonCommand[] = [];
  if (configured) {
    candidates.push({ command: configured, args: [] });
  }
  if (process.platform === "win32") {
    const managedPython = await ensureManagedFluxBootstrapPython(options);
    candidates.push({ command: managedPython, args: [] });
    if (shouldAllowSystemPythonFallback()) {
      candidates.push(
        { command: "py", args: ["-3"] },
        { command: "python", args: [] },
      );
    }
  } else {
    candidates.push(
      { command: "python3", args: [] },
      { command: "python", args: [] },
    );
  }
  for (const candidate of candidates) {
    try {
      await runCommand(candidate.command, [...candidate.args, "--version"], {
        signal: options.signal,
      });
      return candidate;
    } catch (_error) {
      continue;
    }
  }
  throw new Error(
    "Flux Python 런타임을 만들 Python 3 실행 파일을 찾지 못했습니다. 앱 데이터 Python 준비에 실패했거나 MGT_FLUX_PYTHON 경로가 올바르지 않습니다.",
  );
}

async function ensureManagedFluxBootstrapPython(
  options: PythonBootstrapOptions,
): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("Flux Python 런타임에는 Python 3.11 이상이 필요합니다.");
  }
  const config = resolveManagedBootstrapPythonConfig();
  const pythonDir = managedFluxBootstrapPythonDir(
    options.runtimeDir,
    config.version,
  );
  const pythonExe = join(pythonDir, "python.exe");
  const markerPath = join(pythonDir, FLUX_BOOTSTRAP_PYTHON_MARKER);
  if (isCurrentManagedFluxBootstrapPython(pythonExe, markerPath, config)) {
    sanitizeStandaloneEmbeddedPythonPathFile(pythonDir);
    return pythonExe;
  }

  const { getPipPath, zipName, zipPath } = await prepareBootstrapPythonInstall(
    options,
    pythonDir,
    config,
  );
  await installBootstrapPythonArchive(
    options,
    pythonDir,
    pythonExe,
    zipName,
    zipPath,
    config,
  );
  await installBootstrapPythonPip(options, pythonExe, getPipPath, config);
  await writeBootstrapPythonMarker(markerPath, config);
  return pythonExe;
}

function resolveManagedBootstrapPythonConfig(): ManagedBootstrapPythonConfig {
  const version =
    process.env.MANGA_TRANSLATOR_FLUX_PYTHON_VERSION ??
    process.env.MGT_FLUX_PYTHON_VERSION ??
    FLUX_EMBED_PYTHON_VERSION;
  const pythonUrl =
    process.env.MANGA_TRANSLATOR_FLUX_PYTHON_URL ??
    process.env.MGT_FLUX_PYTHON_URL ??
    `https://www.python.org/ftp/python/${version}/python-${version}-embed-amd64.zip`;
  const getPipUrl =
    process.env.MANGA_TRANSLATOR_FLUX_GET_PIP_URL ??
    process.env.MGT_FLUX_GET_PIP_URL ??
    FLUX_GET_PIP_URL;
  const pythonAsset = resolvePinnedRemoteAsset({
    defaultUrl: RUNTIME_INTEGRITY_MANIFEST.managedPython.archive.url,
    defaultSha256: RUNTIME_INTEGRITY_MANIFEST.managedPython.archive.sha256,
    url: pythonUrl,
    overrideSha256:
      process.env.MANGA_TRANSLATOR_FLUX_PYTHON_SHA256 ??
      process.env.MGT_FLUX_PYTHON_SHA256,
    label: "Flux managed Python archive",
  });
  const getPipAsset = resolvePinnedRemoteAsset({
    defaultUrl: RUNTIME_INTEGRITY_MANIFEST.managedPython.getPip.url,
    defaultSha256: RUNTIME_INTEGRITY_MANIFEST.managedPython.getPip.sha256,
    url: getPipUrl,
    overrideSha256:
      process.env.MANGA_TRANSLATOR_FLUX_GET_PIP_SHA256 ??
      process.env.MGT_FLUX_GET_PIP_SHA256,
    label: "Flux managed Python get-pip.py",
  });
  return {
    version,
    pythonUrl: pythonAsset.url,
    pythonSha256: pythonAsset.sha256,
    getPipUrl: getPipAsset.url,
    getPipSha256: getPipAsset.sha256,
  };
}

async function prepareBootstrapPythonInstall(
  options: PythonBootstrapOptions,
  pythonDir: string,
  config: ManagedBootstrapPythonConfig,
): Promise<{ getPipPath: string; zipName: string; zipPath: string }> {
  await rm(pythonDir, { recursive: true, force: true });
  await mkdir(pythonDir, { recursive: true });
  await mkdir(resolveFluxRuntimeTempDir(options.runtimeDir), {
    recursive: true,
  });
  const downloadsDir = join(options.runtimeDir, ".downloads", "python");
  await mkdir(downloadsDir, { recursive: true });
  const zipName =
    basename(new URL(config.pythonUrl).pathname) ||
    `python-${config.version}-embed-amd64.zip`;
  const zipPath = join(downloadsDir, zipName);
  const getPipPath = join(downloadsDir, "get-pip.py");
  return { getPipPath, zipName, zipPath };
}

async function installBootstrapPythonArchive(
  options: PythonBootstrapOptions,
  pythonDir: string,
  pythonExe: string,
  zipName: string,
  zipPath: string,
  config: ManagedBootstrapPythonConfig,
): Promise<void> {
  await downloadToFile({
    url: config.pythonUrl,
    outputPath: zipPath,
    signal: options.signal,
    progressText: "Flux Python 다운로드 중",
    label: zipName,
    maximumBytes: MAX_REMOTE_RUNTIME_ARCHIVE_BYTES,
    expectedSha256: config.pythonSha256,
    onProgress: options.onProgress,
  });
  options.onProgress?.({
    progressText: "Flux Python 압축 해제 중",
    detail: zipName,
    progressMode: "indeterminate",
    installLogLine: "Flux 런타임용 Python을 앱 데이터 폴더에 풀고 있습니다.",
  });
  await extractZipSafely(zipPath, pythonDir, options.signal);
  if (!isExecutableFile(pythonExe)) {
    throw new Error(
      "Flux 런타임용 Python 압축을 풀었지만 python.exe를 찾지 못했습니다.",
    );
  }
  sanitizeStandaloneEmbeddedPythonPathFile(pythonDir);
}

async function installBootstrapPythonPip(
  options: PythonBootstrapOptions,
  pythonExe: string,
  getPipPath: string,
  config: ManagedBootstrapPythonConfig,
): Promise<void> {
  await downloadToFile({
    url: config.getPipUrl,
    outputPath: getPipPath,
    signal: options.signal,
    progressText: "Flux pip 다운로드 중",
    label: "get-pip.py",
    maximumBytes: MAX_REMOTE_SUPPORT_ASSET_BYTES,
    expectedSha256: config.getPipSha256,
    onProgress: options.onProgress,
  });
  options.onProgress?.({
    progressText: "Flux pip 설치 중",
    detail: `Python ${config.version}`,
    progressMode: "indeterminate",
    installLogLine: "Flux 런타임용 Python에 pip를 설치합니다.",
  });
  await runCommand(
    pythonExe,
    [getPipPath, "--no-warn-script-location", "--no-setuptools", "--no-wheel"],
    {
      signal: options.signal,
      env: buildBootstrapPythonEnv(options.runtimeDir),
      onLine: (line) => emitPythonInstallLog(options, line),
    },
  );
}

async function writeBootstrapPythonMarker(
  markerPath: string,
  config: ManagedBootstrapPythonConfig,
): Promise<void> {
  await writeFile(
    markerPath,
    `${JSON.stringify({ ...config, installedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

function managedFluxBootstrapPythonDir(
  runtimeDir: string,
  version = FLUX_EMBED_PYTHON_VERSION,
): string {
  return join(runtimeDir, "bootstrap-python", `python-${version}`);
}

export function managedFluxBootstrapPythonPath(runtimeDir: string): string {
  return join(managedFluxBootstrapPythonDir(runtimeDir), "python.exe");
}

function isCurrentManagedFluxBootstrapPython(
  pythonExe: string,
  markerPath: string,
  expected: ManagedBootstrapPythonConfig,
): boolean {
  try {
    if (!isExecutableFile(pythonExe)) {
      return false;
    }
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<
      typeof expected
    >;
    return (
      marker.version === expected.version &&
      marker.pythonUrl === expected.pythonUrl &&
      marker.pythonSha256 === expected.pythonSha256 &&
      marker.getPipUrl === expected.getPipUrl &&
      marker.getPipSha256 === expected.getPipSha256
    );
  } catch (_error) {
    return false;
  }
}

function shouldAllowSystemPythonFallback(): boolean {
  const explicit =
    process.env.MANGA_TRANSLATOR_FLUX_ALLOW_SYSTEM_PYTHON ??
    process.env.MGT_FLUX_ALLOW_SYSTEM_PYTHON;
  if (explicit !== undefined) {
    return ["1", "true", "yes", "y", "on"].includes(
      String(explicit).trim().toLowerCase(),
    );
  }
  return !isPackagedAppRuntime();
}

function isPackagedAppRuntime(): boolean {
  return Boolean(
    process.resourcesPath &&
    process.resourcesPath
      .toLowerCase()
      .includes(`${normalize("\\resources")}`.toLowerCase()),
  );
}

export function buildBootstrapPythonEnv(runtimeDir: string): NodeJS.ProcessEnv {
  const tmpDir = resolveFluxRuntimeTempDir(runtimeDir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1",
    PYTHONUNBUFFERED: "1",
    TMP: tmpDir,
    TEMP: tmpDir,
    TMPDIR: tmpDir,
  };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  delete env.PYTHONUSERBASE;
  return buildIsolatedPipEnvironment(env, {
    PIP_CACHE_DIR: join(runtimeDir, "pip-cache"),
  });
}
