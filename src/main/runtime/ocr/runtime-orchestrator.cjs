// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {import("../runtime-jsdoc-types").OcrRuntimeLayout} OcrRuntimeLayout */
/** @typedef {{ ok: boolean; message: string; error?: unknown }} ImportCheckResult */
/**
 * @typedef {{
 *   runtimeDir: string;
 *   runtimeVariant: string;
 *   venvDir: string;
 *   venvPython: string;
 *   packageDir: string;
 *   cachePaths: OcrRuntimeLayout;
 *   diagnostics: unknown[];
 *   importCheck: ImportCheckResult;
 *   bootstrapPython: string;
 * }} RuntimeState
 */
const { existsSync } = require("node:fs");
const { mkdir, rm } = require("node:fs/promises");
const {
  emitRuntimeProgress,
  runtimeOverrideEnv,
} = require("./host-services.cjs");
const {
  buildOcrRuntimeEnv,
  isWindowsRocmOcrRuntimePathShortEnough,
  resolveBootstrapPython,
  resolveOcrDeviceLabel,
  resolveOcrInstallSignature,
  resolveOcrPipCacheDir,
  resolveOcrPythonPackageDir,
  resolveOcrRuntimeDir,
  resolveOcrRuntimeVariant,
  resolveOcrTempDir,
  resolveOcrVenvDir,
  resolveVenvPythonPath,
  shouldUseWindowsShortRocmOcrLayout,
} = require("../simple-page-ocr-runtime-config.cjs");
const {
  quoteCommandArg,
  runShellCommand,
} = require("../simple-page-shell-utils.cjs");
const { ensureManagedBootstrapPython } = require("./managed-python.cjs");
const { installAndFinalizeRuntime } = require("./runtime-install-flow.cjs");
const { buildRuntimeLayout } = require("./runtime-layout-result.cjs");
const {
  ensureEmbeddedPythonPackagePath,
  finalizePaddleOcrRuntime,
  preparePaddlexCacheHome,
} = require("./runtime-preparation.cjs");
const {
  checkPaddleOcrImport,
  createOcrRuntimeError,
  hasExpectedOcrPackages,
  hasOcrInstallMarker,
  isTruthy,
} = require("./runtime-verification.cjs");

/** @param {RuntimeOptions} [options] @returns {Promise<OcrRuntimeLayout>} */
async function ensurePaddleOcrRuntime(options = {}) {
  const state = await prepareRuntimeState(options);
  const venvRuntime = await reuseVenvRuntime(options, state);
  if (venvRuntime) {
    return venvRuntime;
  }
  await resolveBootstrapPythonRuntime(options, state);
  const targetRuntime = await reuseTargetRuntime(options, state);
  if (targetRuntime) {
    return targetRuntime;
  }
  await removeBrokenTargetRuntime(options, state);
  assertAutomaticInstallEnabled(options);
  await tryCreateVenv(options, state);
  return installAndFinalizeRuntime(options, state);
}

/** @param {RuntimeOptions} options @returns {Promise<RuntimeState>} */
async function prepareRuntimeState(options) {
  const runtimeDir = resolveOcrRuntimeDir(options);
  const runtimeVariant = resolveOcrRuntimeVariant(options);
  const packageDir = resolveOcrPythonPackageDir(runtimeDir, options);
  validateRocmRuntimePath(options, runtimeDir, packageDir);
  emitRocmRuntimePath(options, runtimeDir);
  await prepareRuntimeDirectories(options, runtimeDir);
  const cachePaths = await preparePaddlexCacheHome(options, runtimeDir);
  const venvDir = resolveOcrVenvDir(runtimeDir, runtimeVariant, options);
  const venvPython = resolveVenvPythonPath(venvDir);
  emitRuntimeCheck(options, runtimeVariant);
  const importCheck = await checkExistingVenv(
    options,
    runtimeDir,
    venvPython,
    cachePaths,
  );
  return {
    runtimeDir,
    runtimeVariant,
    venvDir,
    venvPython,
    packageDir,
    cachePaths,
    diagnostics: [],
    importCheck,
    bootstrapPython: "",
  };
}

/** @param {RuntimeOptions} options @param {string} runtimeDir @param {string} packageDir */
function validateRocmRuntimePath(options, runtimeDir, packageDir) {
  if (
    shouldUseWindowsShortRocmOcrLayout(options) &&
    !isWindowsRocmOcrRuntimePathShortEnough(runtimeDir)
  ) {
    throw createOcrRuntimeError(
      [
        "AMD ROCm OCR 런타임 경로가 Windows 경로 제한에 비해 너무 깁니다.",
        `runtimeDir=${runtimeDir}`,
        "MANGA_TRANSLATOR_OCR_ROCM_RUNTIME_DIR 또는 MANGA_TRANSLATOR_OCR_RUNTIME_DIR을 C:\\MGTOCR 같은 짧은 경로로 지정하세요.",
      ].join(" "),
      { step: "rocm-ocr-runtime-path-too-long", runtimeDir, packageDir },
    );
  }
}

/** @param {RuntimeOptions} options @param {string} runtimeDir */
function emitRocmRuntimePath(options, runtimeDir) {
  if (shouldUseWindowsShortRocmOcrLayout(options)) {
    emitRuntimeProgress(
      options,
      "ocr_preparing",
      "AMD ROCm OCR 런타임 경로 선택",
      runtimeDir,
      {
        progressMode: "log-only",
        installLogLine: `AMD ROCm OCR short runtime: ${runtimeDir}`,
      },
    );
  }
}

/** @param {RuntimeOptions} options @param {string} runtimeDir */
async function prepareRuntimeDirectories(options, runtimeDir) {
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(resolveOcrPipCacheDir(runtimeDir, options), { recursive: true });
  await mkdir(resolveOcrTempDir(runtimeDir, options), { recursive: true });
}

/** @param {RuntimeOptions} options @param {string} runtimeVariant */
function emitRuntimeCheck(options, runtimeVariant) {
  emitRuntimeProgress(
    options,
    "ocr_preparing",
    "Paddle OCR 런타임 확인 중",
    `${resolveOcrDeviceLabel(options)}, ${runtimeVariant}`,
  );
}

/** @param {RuntimeOptions} options @param {string} runtimeDir @param {string} venvPython @param {OcrRuntimeLayout} cachePaths @returns {Promise<ImportCheckResult>} */
async function checkExistingVenv(options, runtimeDir, venvPython, cachePaths) {
  if (!existsSync(venvPython)) {
    return { ok: false, message: "venv python is missing" };
  }
  return checkPaddleOcrImport(venvPython, options, {
    runtimeDir,
    includePackageDir: false,
    ...cachePaths,
  });
}

/** @param {RuntimeOptions} options @param {RuntimeState} state @returns {Promise<OcrRuntimeLayout | null>} */
async function reuseVenvRuntime(options, state) {
  if (!existsSync(state.venvPython) || !state.importCheck.ok) {
    return null;
  }
  if (hasOcrInstallMarker(state.packageDir, state.runtimeVariant, options)) {
    return finalizePaddleOcrRuntime(
      options,
      buildRuntimeLayout(state, state.venvPython, false),
    );
  }
  recordSignatureMismatch(
    state,
    "venv-runtime-signature-mismatch",
    state.venvPython,
    options,
  );
  emitSignatureChanged(options);
  await rm(state.venvDir, { recursive: true, force: true });
  await rm(state.packageDir, { recursive: true, force: true });
  state.importCheck = signatureChangedImportCheck();
  return null;
}

/** @param {RuntimeState} state @param {string} step @param {string} pythonPath @param {RuntimeOptions} options */
function recordSignatureMismatch(state, step, pythonPath, options) {
  state.diagnostics.push({
    step,
    runtimeDir: state.runtimeDir,
    runtimeVariant: state.runtimeVariant,
    packageDir: state.packageDir,
    pythonPath,
    expectedSignature: resolveOcrInstallSignature(options),
  });
}

/** @param {RuntimeOptions} options */
function emitSignatureChanged(options) {
  emitRuntimeProgress(
    options,
    "ocr_downloading",
    "Paddle OCR 런타임 재설치 중",
    "패키지 구성이 바뀌어 기존 OCR 런타임을 다시 준비합니다.",
    {
      progressMode: "log-only",
      installLogLine:
        "기존 OCR 런타임 패키지 구성이 현재 버전과 달라 재설치합니다.",
    },
  );
}

/** @returns {ImportCheckResult} */
function signatureChangedImportCheck() {
  return { ok: false, message: "OCR runtime package signature changed" };
}

/** @param {RuntimeOptions} options @param {RuntimeState} state */
async function resolveBootstrapPythonRuntime(options, state) {
  state.bootstrapPython =
    resolveBootstrapPython(options) ||
    (await ensureManagedBootstrapPython(options, state.runtimeDir));
  ensureEmbeddedPythonPackagePath(
    state.bootstrapPython,
    state.packageDir,
    state.runtimeDir,
  );
  if (!existsSync(state.venvPython)) {
    state.importCheck = await checkPaddleOcrImport(
      state.bootstrapPython,
      options,
      {
        runtimeDir: state.runtimeDir,
        packageDir: state.packageDir,
        includePackageDir: true,
        ...state.cachePaths,
      },
    );
  }
}

/** @param {RuntimeOptions} options @param {RuntimeState} state @returns {Promise<OcrRuntimeLayout | null>} */
async function reuseTargetRuntime(options, state) {
  if (existsSync(state.venvPython) || !state.importCheck.ok) {
    return null;
  }
  if (hasOcrInstallMarker(state.packageDir, state.runtimeVariant, options)) {
    return finalizePaddleOcrRuntime(options, {
      ...buildRuntimeLayout(state, state.bootstrapPython, true),
      diagnostics: [
        { step: "embedded-python-ready", packageDir: state.packageDir },
      ],
    });
  }
  recordSignatureMismatch(
    state,
    "target-runtime-signature-mismatch",
    state.bootstrapPython,
    options,
  );
  emitSignatureChanged(options);
  await rm(state.packageDir, { recursive: true, force: true });
  ensureEmbeddedPythonPackagePath(
    state.bootstrapPython,
    state.packageDir,
    state.runtimeDir,
  );
  state.importCheck = signatureChangedImportCheck();
  return null;
}

/** @param {RuntimeOptions} options @param {RuntimeState} state */
async function removeBrokenTargetRuntime(options, state) {
  const looksInstalled =
    hasOcrInstallMarker(state.packageDir, state.runtimeVariant, options) ||
    hasExpectedOcrPackages(state.packageDir, options);
  if (!looksInstalled || state.importCheck.ok) {
    return;
  }
  state.diagnostics.push({
    step: "installed-runtime-verification-failed",
    runtimeDir: state.runtimeDir,
    runtimeVariant: state.runtimeVariant,
    packageDir: state.packageDir,
    pythonPath: existsSync(state.venvPython)
      ? state.venvPython
      : state.bootstrapPython,
    importError: state.importCheck.message,
  });
  await rm(state.packageDir, { recursive: true, force: true });
  ensureEmbeddedPythonPackagePath(
    state.bootstrapPython,
    state.packageDir,
    state.runtimeDir,
  );
}

/** @param {RuntimeOptions} options */
function assertAutomaticInstallEnabled(options) {
  const enabled = isTruthy(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_AUTO_INSTALL", options) ?? "true",
  );
  if (!enabled) {
    throw new Error(
      "PaddleOCR-VL runtime is not installed and automatic installation is disabled.",
    );
  }
}

/** @param {RuntimeOptions} options @param {RuntimeState} state */
async function tryCreateVenv(options, state) {
  state.diagnostics.push({
    step: "bootstrap-python",
    pythonPath: state.bootstrapPython,
  });
  if (existsSync(state.venvPython)) {
    return;
  }
  try {
    emitVenvCreation(options, state.runtimeDir);
    await runShellCommand(
      `${quoteCommandArg(state.bootstrapPython)} -m venv ${quoteCommandArg(state.venvDir)}`,
      {
        timeoutMs: 180000,
        env: buildOcrRuntimeEnv(options, {
          runtimeDir: state.runtimeDir,
          includePackageDir: false,
          ...state.cachePaths,
        }),
        signal: options.abortSignal,
      },
    );
    state.diagnostics.push({ step: "venv-created", venvDir: state.venvDir });
  } catch (error) {
    state.diagnostics.push({
      step: "venv-create-failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** @param {RuntimeOptions} options @param {string} runtimeDir */
function emitVenvCreation(options, runtimeDir) {
  emitRuntimeProgress(
    options,
    "ocr_downloading",
    "Paddle OCR Python 환경 생성 중",
    runtimeDir,
    {
      progressMode: "log-only",
      installLogLine: "Python 가상환경을 생성합니다.",
    },
  );
}

module.exports = { ensurePaddleOcrRuntime };
