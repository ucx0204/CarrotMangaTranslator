// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {import("../runtime-jsdoc-types").OcrRuntimeLayout} OcrRuntimeLayout */
/** @typedef {{ ok: boolean; message: string; error?: unknown }} ImportCheckResult */
/**
 * @typedef {{
 *   runtimeDir: string;
 *   runtimeVariant: string;
 *   venvPython: string;
 *   packageDir: string;
 *   cachePaths: OcrRuntimeLayout;
 *   diagnostics: unknown[];
 *   bootstrapPython: string;
 * }} RuntimeState
 */
/** @typedef {{ installPython: string; targetDir: string | null; installBatches: string[][]; packageSummary: string }} InstalledRuntime */

const { existsSync } = require("node:fs");
const {
  buildPaddleOcrImportFailureMessage,
  isPaddleNativeDllLoadFailureText,
  resolveOcrInstallSignature,
  resolveOcrPipInstallBatches,
  summarizeOcrInstallBatches,
} = require("../simple-page-ocr-runtime-config.cjs");
const { emitRuntimeProgress } = require("./host-services.cjs");
const { summarizeImportCheckFailure } = require("./managed-python.cjs");
const {
  ensureMicrosoftVisualCppRuntimeForPaddle,
} = require("./managed-vcredist.cjs");
const { installOcrPythonPackages } = require("./runtime-installer.cjs");
const { buildRuntimeLayout } = require("./runtime-layout-result.cjs");
const {
  ensureEmbeddedPythonPackagePath,
  finalizePaddleOcrRuntime,
} = require("./runtime-preparation.cjs");
const {
  checkPaddleOcrImport,
  createOcrRuntimeError,
  writeOcrInstallMarker,
} = require("./runtime-verification.cjs");

/** @param {RuntimeOptions} options @param {RuntimeState} state @returns {Promise<OcrRuntimeLayout>} */
async function installAndFinalizeRuntime(options, state) {
  const installed = await installPackagesWithFallback(options, state);
  await verifyInstalledRuntime(options, state, installed);
  await persistInstalledRuntime(options, state, installed);
  return finalizePaddleOcrRuntime(
    options,
    buildRuntimeLayout(
      state,
      installed.installPython,
      Boolean(installed.targetDir),
    ),
  );
}

/** @param {RuntimeOptions} options @param {RuntimeState} state @returns {Promise<InstalledRuntime>} */
async function installPackagesWithFallback(options, state) {
  const installBatches = resolveOcrPipInstallBatches(options);
  const packageSummary = summarizeOcrInstallBatches(installBatches, options);
  let installPython = existsSync(state.venvPython)
    ? state.venvPython
    : state.bootstrapPython;
  let targetDir = existsSync(state.venvPython) ? null : state.packageDir;
  emitPackageInstallStart(options, packageSummary, false);
  try {
    await installOcrPythonPackages(
      installPython,
      installBatches,
      targetDir,
      options,
      state.runtimeDir,
    );
  } catch (error) {
    if (installPython === state.bootstrapPython) {
      throw error;
    }
    recordVenvInstallFailure(state, error);
    installPython = state.bootstrapPython;
    targetDir = state.packageDir;
    ensureEmbeddedPythonPackagePath(
      installPython,
      state.packageDir,
      state.runtimeDir,
    );
    emitPackageInstallStart(options, packageSummary, true);
    await installOcrPythonPackages(
      installPython,
      installBatches,
      targetDir,
      options,
      state.runtimeDir,
    );
  }
  state.diagnostics.push({
    step: "pip-installed",
    installBatches,
    targetDir,
    runtimeVariant: state.runtimeVariant,
  });
  return { installPython, targetDir, installBatches, packageSummary };
}

/** @param {RuntimeOptions} options @param {string} packageSummary @param {boolean} retry */
function emitPackageInstallStart(options, packageSummary, retry) {
  emitRuntimeProgress(
    options,
    "ocr_downloading",
    retry
      ? "Paddle OCR 패키지 재설치 중"
      : "Paddle OCR 패키지 다운로드/설치 중",
    packageSummary,
    {
      progressMode: "log-only",
      installLogLine: retry
        ? "가상환경 설치에 실패해 내장 Python 경로로 다시 설치합니다."
        : "Paddle OCR 패키지 설치를 시작합니다.",
    },
  );
}

/** @param {RuntimeState} state @param {unknown} error */
function recordVenvInstallFailure(state, error) {
  state.diagnostics.push({
    step: "venv-pip-install-failed",
    message: error instanceof Error ? error.message : String(error),
  });
}

/** @param {RuntimeOptions} options @param {RuntimeState} state @param {InstalledRuntime} installed */
async function verifyInstalledRuntime(options, state, installed) {
  emitInstallVerification(options, installed.packageSummary, false);
  let importCheck = await checkInstalledRuntime(options, state, installed);
  if (shouldRetryAfterVcredist(importCheck)) {
    recordNativeDllFailure(state, installed.installPython, importCheck);
    await ensureMicrosoftVisualCppRuntimeForPaddle(options, state.runtimeDir);
    emitInstallVerification(options, installed.packageSummary, true);
    importCheck = await checkInstalledRuntime(options, state, installed);
  }
  if (!importCheck.ok) {
    throwPostInstallVerificationError(options, state, installed, importCheck);
  }
}

/** @param {RuntimeOptions} options @param {RuntimeState} state @param {InstalledRuntime} installed @returns {Promise<ImportCheckResult>} */
function checkInstalledRuntime(options, state, installed) {
  return checkPaddleOcrImport(installed.installPython, options, {
    runtimeDir: state.runtimeDir,
    packageDir: state.packageDir,
    includePackageDir: Boolean(installed.targetDir),
    ...state.cachePaths,
  });
}

/** @param {ImportCheckResult} importCheck @returns {boolean} */
function shouldRetryAfterVcredist(importCheck) {
  return (
    !importCheck.ok &&
    isPaddleNativeDllLoadFailureText(summarizeImportCheckFailure(importCheck))
  );
}

/** @param {RuntimeState} state @param {string} pythonPath @param {ImportCheckResult} importCheck */
function recordNativeDllFailure(state, pythonPath, importCheck) {
  state.diagnostics.push({
    step: "paddle-native-dll-load-failed",
    runtimeDir: state.runtimeDir,
    runtimeVariant: state.runtimeVariant,
    packageDir: state.packageDir,
    pythonPath,
    importError: summarizeImportCheckFailure(importCheck),
  });
}

/** @param {RuntimeOptions} options @param {string} packageSummary @param {boolean} retry */
function emitInstallVerification(options, packageSummary, retry) {
  emitRuntimeProgress(
    options,
    "ocr_downloading",
    retry ? "Paddle OCR 설치 재검증 중" : "Paddle OCR 설치 검증 중",
    packageSummary,
    {
      progressMode: "indeterminate",
      installLogLine: retry
        ? "Microsoft Visual C++ 런타임 준비 후 Paddle OCR import를 다시 확인합니다."
        : "Paddle OCR import와 장치 상태를 확인합니다.",
    },
  );
}

/** @param {RuntimeOptions} options @param {RuntimeState} state @param {InstalledRuntime} installed @param {ImportCheckResult} importCheck */
function throwPostInstallVerificationError(
  options,
  state,
  installed,
  importCheck,
) {
  const importError = summarizeImportCheckFailure(importCheck);
  throw createOcrRuntimeError(
    buildPaddleOcrImportFailureMessage(importError, options),
    {
      step: "post-install-verification-failed",
      runtimeDir: state.runtimeDir,
      runtimeVariant: state.runtimeVariant,
      packageDir: state.packageDir,
      pythonPath: installed.installPython,
      importError,
    },
    importCheck.error,
  );
}

/** @param {RuntimeOptions} options @param {RuntimeState} state @param {InstalledRuntime} installed */
async function persistInstalledRuntime(options, state, installed) {
  await writeOcrInstallMarker(state.packageDir, {
    runtimeVariant: state.runtimeVariant,
    installBatches: installed.installBatches,
    targetDir: installed.targetDir,
    packageSignature: resolveOcrInstallSignature(options),
    installedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
  });
  emitRuntimeProgress(
    options,
    "ocr_downloading",
    "Paddle OCR 설치 완료",
    installed.packageSummary,
    {
      progressMode: "determinate",
      progressPercent: 1,
      installLogLine: "Paddle OCR 설치가 완료되었습니다.",
    },
  );
}

module.exports = { installAndFinalizeRuntime };
