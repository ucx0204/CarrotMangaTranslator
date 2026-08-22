// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {{ ok: boolean; message: string; error?: unknown }} ImportCheckResult */
/** @typedef {{ version: string; pythonUrl: string; pythonSha256: string; getPipUrl: string; getPipSha256: string; installedFileSha256?: Record<string, string> }} ManagedPythonMarker */
/** @typedef {{ label: string; file: string; url: string; destination: string; maximumBytes: number; expectedSha256: string; progressTitle?: string; completeTitle?: string; [key: string]: unknown }} RuntimeDownloadTask */
/**
 * @typedef {ManagedPythonMarker & {
 *   runtimeDir: string;
 *   pythonDir: string;
 *   pythonExe: string;
 *   markerPath: string;
 *   downloadsDir: string;
 *   zipName: string;
 *   zipPath: string;
 *   getPipPath: string;
 * }} ManagedPythonContext
 */

const { existsSync, readFileSync } = require("node:fs");
const { mkdir, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");
const {
  buildIsolatedPipEnvironment,
} = require("../python-pip-environment.cjs");
const {
  emitRuntimeProgress,
  runtimeOverrideEnv,
} = require("./host-services.cjs");
const {
  resolveOcrTempDir,
  summarizeOcrErrorMessage,
} = require("../simple-page-ocr-runtime-config.cjs");
const {
  downloadHfFileWithProgress,
  probeContentLength,
} = require("../simple-page-download-utils.cjs");
const { runCommand } = require("../simple-page-shell-utils.cjs");
const { extractSelectedZipEntries } = require("../simple-page-zip-utils.cjs");
const {
  createRuntimeStagingDirectory,
  replaceDirectoryWithRollback,
} = require("../runtime-directory-publish.cjs");
const {
  sanitizeStandaloneEmbeddedPythonPathFile,
} = require("./managed-python-path.cjs");
const { createOcrRuntimeError } = require("./runtime-verification.cjs");
const {
  MAX_REMOTE_RUNTIME_ARCHIVE_BYTES,
  MAX_REMOTE_SUPPORT_ASSET_BYTES,
} = require("../transport/download-budgets.cjs");
const {
  RUNTIME_INTEGRITY_MANIFEST,
  resolvePinnedRemoteAsset,
} = require("../runtime-integrity.cjs");
const {
  collectManagedPythonExecutableHashes,
  installedManagedPythonHashesMatch,
  managedPythonMarkerMatches,
} = require("./managed-python-integrity.cjs");

const DEFAULT_MANAGED_PYTHON = RUNTIME_INTEGRITY_MANIFEST.managedPython;
const DEFAULT_EMBED_PYTHON_VERSION = DEFAULT_MANAGED_PYTHON.version;
const DEFAULT_GET_PIP_URL = DEFAULT_MANAGED_PYTHON.getPip.url;
const PYTHON_RUNTIME_MARKER_FILE = ".mgt-bootstrap-python.json";

/** @param {RuntimeOptions} options @param {string} runtimeDir @returns {Promise<string>} */
async function ensureManagedBootstrapPython(options = {}, runtimeDir) {
  assertManagedPythonPlatform();
  const context = resolveManagedPythonContext(options, runtimeDir);
  // The managed package directory is intentionally injected into the
  // embeddable Python ._pth file while OCR is running. Restore that mutable
  // line to the canonical bootstrap state before comparing the installation
  // hashes, otherwise every subsequent OCR job mistakes the expected path
  // update for tampering and reinstalls Python and pip.
  sanitizeStandaloneEmbeddedPythonPathFile(
    context.pythonDir,
    context.runtimeDir,
  );
  if (
    isCurrentManagedBootstrapPython(
      context.pythonExe,
      context.markerPath,
      context,
    )
  ) {
    return context.pythonExe;
  }
  emitManagedPythonPreparation(options, context.version);
  await prepareManagedPythonDownloads(context);
  const stagedContext = await downloadAndExtractManagedPython(options, context);
  try {
    await installManagedPythonPip(options, stagedContext);
    await writeManagedPythonMarker(stagedContext);
    await replaceDirectoryWithRollback(
      stagedContext.pythonDir,
      context.pythonDir,
    );
  } catch (error) {
    await rm(stagedContext.pythonDir, { recursive: true, force: true });
    throw error;
  }
  emitManagedPythonReady(options, context.version);
  return context.pythonExe;
}

function assertManagedPythonPlatform() {
  if (process.platform !== "win32") {
    throw new Error(
      "Paddle OCR bbox provider needs Python. Install Python 3 or set MANGA_TRANSLATOR_OCR_PYTHON.",
    );
  }
}

/** @param {RuntimeOptions} options @param {string} runtimeDir @returns {ManagedPythonContext} */
function resolveManagedPythonContext(options, runtimeDir) {
  const version = String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_EMBED_PYTHON_VERSION", options) ||
      DEFAULT_EMBED_PYTHON_VERSION,
  ).trim();
  const pythonUrl = String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_EMBED_PYTHON_URL", options) ||
      `https://www.python.org/ftp/python/${version}/python-${version}-embed-amd64.zip`,
  ).trim();
  const getPipUrl = String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_GET_PIP_URL", options) ||
      DEFAULT_GET_PIP_URL,
  ).trim();
  const pythonAsset = resolvePinnedRemoteAsset({
    defaultUrl: DEFAULT_MANAGED_PYTHON.archive.url,
    defaultSha256: DEFAULT_MANAGED_PYTHON.archive.sha256,
    url: pythonUrl,
    overrideSha256: runtimeOverrideEnv(
      "MANGA_TRANSLATOR_EMBED_PYTHON_SHA256",
      options,
    ),
    label: "Managed Python archive",
  });
  const getPipAsset = resolvePinnedRemoteAsset({
    defaultUrl: DEFAULT_MANAGED_PYTHON.getPip.url,
    defaultSha256: DEFAULT_MANAGED_PYTHON.getPip.sha256,
    url: getPipUrl,
    overrideSha256: runtimeOverrideEnv(
      "MANGA_TRANSLATOR_GET_PIP_SHA256",
      options,
    ),
    label: "Managed Python get-pip.py",
  });
  const pythonDir = path.join(
    runtimeDir,
    "bootstrap-python",
    `python-${version}`,
  );
  const downloadsDir = path.join(runtimeDir, ".downloads", "python");
  const zipName =
    path.basename(new URL(pythonUrl).pathname) ||
    `python-${version}-embed-amd64.zip`;
  return {
    version,
    pythonUrl: pythonAsset.url,
    pythonSha256: pythonAsset.sha256,
    getPipUrl: getPipAsset.url,
    getPipSha256: getPipAsset.sha256,
    runtimeDir,
    pythonDir,
    pythonExe: path.join(pythonDir, "python.exe"),
    markerPath: path.join(pythonDir, PYTHON_RUNTIME_MARKER_FILE),
    downloadsDir,
    zipName,
    zipPath: path.join(downloadsDir, zipName),
    getPipPath: path.join(downloadsDir, "get-pip.py"),
  };
}

/** @param {RuntimeOptions} options @param {string} version */
function emitManagedPythonPreparation(options, version) {
  emitRuntimeProgress(
    options,
    "ocr_downloading",
    "Paddle OCR Python 준비 중",
    `Python ${version}`,
    {
      progressMode: "log-only",
      installLogLine:
        "설치 파일에 Python을 묶지 않았기 때문에 OCR용 Python을 앱 데이터 폴더에 준비합니다.",
    },
  );
}

/** @param {ManagedPythonContext} context @returns {Promise<void>} */
async function prepareManagedPythonDownloads(context) {
  await mkdir(context.downloadsDir, { recursive: true });
}

/** @param {RuntimeOptions} options @param {ManagedPythonContext} context @returns {Promise<ManagedPythonContext>} */
async function downloadAndExtractManagedPython(options, context) {
  await downloadGenericFileWithRuntimeProgress(
    {
      label: "Paddle OCR Python",
      file: context.zipName,
      url: context.pythonUrl,
      destination: context.zipPath,
      maximumBytes: MAX_REMOTE_RUNTIME_ARCHIVE_BYTES,
      expectedSha256: context.pythonSha256,
      progressTitle: "Paddle OCR Python 다운로드 중",
      completeTitle: "Paddle OCR Python 다운로드 완료",
    },
    options,
  );
  emitRuntimeProgress(
    options,
    "ocr_downloading",
    "Paddle OCR Python 압축 해제 중",
    context.zipName,
    {
      progressMode: "indeterminate",
      installLogLine: "OCR용 Python 압축을 앱 데이터 폴더에 풀고 있습니다.",
    },
  );
  const stagingDir = createRuntimeStagingDirectory(context.pythonDir);
  const stagedContext = {
    ...context,
    pythonDir: stagingDir,
    pythonExe: path.join(stagingDir, "python.exe"),
    markerPath: path.join(stagingDir, PYTHON_RUNTIME_MARKER_FILE),
  };
  await rm(stagingDir, { recursive: true, force: true });
  try {
    await extractSelectedZipEntries(context.zipPath, stagingDir, () => true, {
      abortSignal: options.abortSignal,
      finalOutputDir: context.pythonDir,
      preserveRelativePaths: true,
    });
    if (!existsSync(path.join(stagingDir, "python.exe"))) {
      throw createOcrRuntimeError(
        "OCR용 Python 압축을 풀었지만 python.exe를 찾지 못했습니다.",
        { pythonDir: context.pythonDir, pythonUrl: context.pythonUrl },
      );
    }
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
  sanitizeStandaloneEmbeddedPythonPathFile(stagingDir, context.runtimeDir);
  return stagedContext;
}

/** @param {RuntimeOptions} options @param {ManagedPythonContext} context @returns {Promise<void>} */
async function installManagedPythonPip(options, context) {
  await downloadGenericFileWithRuntimeProgress(
    {
      label: "Paddle OCR pip",
      file: "get-pip.py",
      url: context.getPipUrl,
      destination: context.getPipPath,
      maximumBytes: MAX_REMOTE_SUPPORT_ASSET_BYTES,
      expectedSha256: context.getPipSha256,
      progressTitle: "Paddle OCR pip 다운로드 중",
      completeTitle: "Paddle OCR pip 다운로드 완료",
    },
    options,
  );
  emitRuntimeProgress(
    options,
    "ocr_downloading",
    "Paddle OCR pip 설치 중",
    `Python ${context.version}`,
    {
      progressMode: "indeterminate",
      installLogLine: "OCR용 Python에 pip를 설치합니다.",
    },
  );
  await runCommand(
    {
      executable: context.pythonExe,
      args: [
        context.getPipPath,
        "--no-warn-script-location",
        "--no-setuptools",
        "--no-wheel",
      ],
    },
    {
      timeoutMs: 300000,
      env: buildBootstrapPythonEnv(context.runtimeDir, options),
      signal: options.abortSignal,
      onOutput: (line) => emitPipInstallLine(options, context.version, line),
    },
  );
}

/** @param {RuntimeOptions} options @param {string} version @param {string} line */
function emitPipInstallLine(options, version, line) {
  emitRuntimeProgress(
    options,
    "ocr_downloading",
    "Paddle OCR pip 설치 중",
    `Python ${version}`,
    { progressMode: "indeterminate", installLogLine: line },
  );
}

/** @param {ManagedPythonContext} context @returns {Promise<void>} */
async function writeManagedPythonMarker(context) {
  await writeFile(
    context.markerPath,
    `${JSON.stringify(
      {
        version: context.version,
        pythonUrl: context.pythonUrl,
        pythonSha256: context.pythonSha256,
        getPipUrl: context.getPipUrl,
        getPipSha256: context.getPipSha256,
        installedFileSha256: collectManagedPythonExecutableHashes(
          context.pythonDir,
        ),
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

/** @param {RuntimeOptions} options @param {string} version */
function emitManagedPythonReady(options, version) {
  emitRuntimeProgress(
    options,
    "ocr_downloading",
    "Paddle OCR Python 준비 완료",
    `Python ${version}`,
    {
      progressMode: "determinate",
      progressPercent: 1,
      installLogLine: "OCR용 Python 준비가 완료되었습니다.",
    },
  );
}

/** @param {ImportCheckResult} importCheck @returns {string} */
function summarizeImportCheckFailure(importCheck) {
  return summarizeOcrErrorMessage(
    importCheck?.error || importCheck?.message || "",
  );
}

/** @param {string} pythonExe @param {string} markerPath @param {ManagedPythonMarker} expected @returns {boolean} */
function isCurrentManagedBootstrapPython(pythonExe, markerPath, expected) {
  try {
    if (!existsSync(pythonExe)) {
      return false;
    }
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    return (
      managedPythonMarkerMatches(marker, expected) &&
      installedManagedPythonHashesMatch(
        path.dirname(markerPath),
        marker?.installedFileSha256,
      )
    );
  } catch (_error) {
    return false;
  }
}

/** @param {RuntimeDownloadTask} task @param {RuntimeOptions} [options] @returns {Promise<void>} */
async function downloadGenericFileWithRuntimeProgress(task, options = {}) {
  const totalBytes = await probeContentLength(
    task.url,
    options.abortSignal,
    task.maximumBytes,
  );
  await downloadHfFileWithProgress(
    { ...task, kind: "runtime", progressPhase: "ocr_downloading" },
    options,
    { totalBytes, knownAggregateBytes: 0, completedBytes: 0 },
  );
}

/** @param {string} runtimeDir @param {RuntimeOptions} [options] @returns {NodeJS.ProcessEnv} */
function buildBootstrapPythonEnv(runtimeDir, options = {}) {
  const tempDir = resolveOcrTempDir(runtimeDir, options);
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1",
    PYTHONUNBUFFERED: "1",
    TMP: tempDir,
    TEMP: tempDir,
    TMPDIR: tempDir,
  };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  delete env.PYTHONUSERBASE;
  return buildIsolatedPipEnvironment(env, {
    PIP_CACHE_DIR: path.join(runtimeDir, "pip-cache"),
  });
}

module.exports = {
  ensureManagedBootstrapPython,
  summarizeImportCheckFailure,
};
