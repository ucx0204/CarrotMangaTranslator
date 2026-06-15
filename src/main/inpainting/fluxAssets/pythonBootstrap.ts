import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, normalize, resolve } from "node:path";
import {
  FLUX_BOOTSTRAP_PYTHON_MARKER,
  FLUX_EMBED_PYTHON_VERSION,
  FLUX_GET_PIP_URL,
  resolveFluxRuntimeTempDir,
} from "./constants";
import type { FluxAssetProgress, PythonCommand } from "./types";
import { downloadToFile, extractZipSafely } from "./downloads";
import { runCommand } from "./errors";
import { emitPythonInstallLog } from "./progress";
import { isExecutableFile, isPathInside } from "./fileProbe";

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

async function ensureManagedFluxBootstrapPython(options: {
  runtimeDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("Flux Python 런타임에는 Python 3.11 이상이 필요합니다.");
  }
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
  const pythonDir = managedFluxBootstrapPythonDir(options.runtimeDir, version);
  const pythonExe = join(pythonDir, "python.exe");
  const markerPath = join(pythonDir, FLUX_BOOTSTRAP_PYTHON_MARKER);
  if (
    isCurrentManagedFluxBootstrapPython(pythonExe, markerPath, {
      version,
      pythonUrl,
      getPipUrl,
    })
  ) {
    sanitizeStandaloneEmbeddedPythonPathFile(pythonDir);
    return pythonExe;
  }

  await rm(pythonDir, { recursive: true, force: true });
  await mkdir(pythonDir, { recursive: true });
  await mkdir(resolveFluxRuntimeTempDir(options.runtimeDir), {
    recursive: true,
  });
  const downloadsDir = join(options.runtimeDir, ".downloads", "python");
  await mkdir(downloadsDir, { recursive: true });
  const zipName =
    basename(new URL(pythonUrl).pathname) ||
    `python-${version}-embed-amd64.zip`;
  const zipPath = join(downloadsDir, zipName);
  const getPipPath = join(downloadsDir, "get-pip.py");

  await downloadToFile({
    url: pythonUrl,
    outputPath: zipPath,
    signal: options.signal,
    progressText: "Flux Python 다운로드 중",
    label: zipName,
    onProgress: options.onProgress,
  });
  options.onProgress?.({
    progressText: "Flux Python 압축 해제 중",
    detail: zipName,
    progressMode: "indeterminate",
    installLogLine: "Flux 런타임용 Python을 앱 데이터 폴더에 풀고 있습니다.",
  });
  extractZipSafely(zipPath, pythonDir);
  if (!isExecutableFile(pythonExe)) {
    throw new Error(
      "Flux 런타임용 Python 압축을 풀었지만 python.exe를 찾지 못했습니다.",
    );
  }
  sanitizeStandaloneEmbeddedPythonPathFile(pythonDir);

  await downloadToFile({
    url: getPipUrl,
    outputPath: getPipPath,
    signal: options.signal,
    progressText: "Flux pip 다운로드 중",
    label: "get-pip.py",
    onProgress: options.onProgress,
  });
  options.onProgress?.({
    progressText: "Flux pip 설치 중",
    detail: `Python ${version}`,
    progressMode: "indeterminate",
    installLogLine: "Flux 런타임용 Python에 pip를 설치합니다.",
  });
  await runCommand(pythonExe, [getPipPath, "--no-warn-script-location"], {
    signal: options.signal,
    env: buildBootstrapPythonEnv(options.runtimeDir),
    onLine: (line) => emitPythonInstallLog(options, line),
  });
  await writeFile(
    markerPath,
    `${JSON.stringify({ version, pythonUrl, getPipUrl, installedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  return pythonExe;
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
  expected: { version: string; pythonUrl: string; getPipUrl: string },
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
      marker.getPipUrl === expected.getPipUrl
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
  };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  delete env.PYTHONUSERBASE;
  return env;
}

export function ensureEmbeddedPythonPackagePath(
  pythonPath: string,
  packageDir: string,
): void {
  if (basename(pythonPath).toLowerCase() !== "python.exe") {
    return;
  }
  const pythonDir = dirname(resolve(pythonPath));
  let pthName: string | undefined;
  try {
    pthName = readdirSync(pythonDir).find((name) =>
      /^python\d+._pth$/i.test(name),
    );
  } catch (_error) {
    return;
  }
  if (!pthName) {
    return;
  }
  const pthPath = join(pythonDir, pthName);
  try {
    const normalizedPackageDir = resolve(packageDir);
    const text = readFileSync(pthPath, "utf8");
    const nextLines = text
      .split(/\r?\n/)
      .filter(
        (line) =>
          !isManagedFluxPackagePathLine(line, pythonDir, normalizedPackageDir),
      )
      .map((line) => (line.trim() === "#import site" ? "import site" : line));
    const importSiteIndex = nextLines.findIndex(
      (line) => line.trim() === "import site",
    );
    if (importSiteIndex === -1) {
      nextLines.push(normalizedPackageDir, "import site");
    } else {
      nextLines.splice(importSiteIndex, 0, normalizedPackageDir);
    }
    const nextText = `${nextLines.filter((line, index, array) => index < array.length - 1 || line.trim()).join("\n")}\n`;
    if (nextText !== text) {
      writeFileSync(pthPath, nextText, "utf8");
    }
  } catch (_error) {
    // If the ._pth file cannot be updated, PYTHONPATH still helps non-isolated Python builds.
  }
}

export function sanitizeStandaloneEmbeddedPythonPathFile(
  outputDir: string,
): void {
  let pthName: string | undefined;
  try {
    pthName = readdirSync(outputDir).find((name) =>
      /^python\d+._pth$/i.test(name),
    );
  } catch (_error) {
    return;
  }
  if (!pthName) {
    return;
  }
  const pthPath = join(outputDir, pthName);
  try {
    const text = readFileSync(pthPath, "utf8");
    const sanitized: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "#import site" || trimmed === "import site") {
        continue;
      }
      if (isManagedFluxPackagePathLine(trimmed, outputDir)) {
        continue;
      }
      if (!trimmed && sanitized[sanitized.length - 1] === "") {
        continue;
      }
      sanitized.push(line);
    }
    const nextText = buildStandaloneEmbeddedPythonPathText(
      outputDir,
      pthName,
      sanitized,
    );
    if (nextText !== text) {
      writeFileSync(pthPath, nextText, "utf8");
    }
  } catch (_error) {
    // The runtime can still fail with a clear pip/import error later.
  }
}

function buildStandaloneEmbeddedPythonPathText(
  outputDir: string,
  pthName: string,
  lines: string[],
): string {
  const normalizedLines = lines
    .map((line) => line.trim())
    .filter(
      (line) => line && line !== "import site" && line !== "#import site",
    );
  const pthEntries: string[] = [];
  const addEntry = (entry: string) => {
    if (
      !entry ||
      pthEntries.some((line) => line.toLowerCase() === entry.toLowerCase())
    ) {
      return;
    }
    pthEntries.push(entry);
  };

  const stdlibZipName = pthName.replace(/._pth$/i, ".zip");
  if (existsSync(join(outputDir, stdlibZipName))) {
    addEntry(stdlibZipName);
  }
  addEntry(".");
  for (const line of normalizedLines) {
    addEntry(line);
  }
  addEntry("import site");
  return `${pthEntries.join("\n")}\n`;
}

function isManagedFluxPackagePathLine(
  line: string,
  pythonDir: string,
  packageDir?: string,
): boolean {
  const trimmed = line.trim();
  if (
    !trimmed ||
    trimmed === "." ||
    trimmed === "import site" ||
    trimmed.startsWith("#")
  ) {
    return false;
  }
  try {
    const resolvedLine = resolve(pythonDir, trimmed);
    if (packageDir && isPathInside(resolvedLine, packageDir)) {
      return true;
    }
    const baseName = basename(resolvedLine).toLowerCase();
    if (!baseName.startsWith("python-packages")) {
      return false;
    }
    const normalized = resolvedLine.replace(/\\/g, "/").toLowerCase();
    return (
      normalized.includes("/mgt-flux-python-") ||
      normalized.includes("/models/inpainting/")
    );
  } catch (_error) {
    return false;
  }
}
