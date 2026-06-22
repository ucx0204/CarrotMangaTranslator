// @ts-check
/** @typedef {import("./runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {import("./runtime-jsdoc-types").OcrRuntimeLayout} OcrRuntimeLayout */
/**
 * @typedef {{ ok: boolean; message: string; error?: unknown }} ImportCheckResult
 * @typedef {{ version: string; pythonUrl: string; getPipUrl: string }} ManagedPythonMarker
 * @typedef {{ label: string; file: string; url: string; destination: string; progressTitle?: string; completeTitle?: string; [key: string]: unknown }} RuntimeDownloadTask
 * @typedef {{ start: number; end: number }} ProgressRange
 */
const {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} = require("node:fs");
const {
  lstat,
  mkdir,
  readlink,
  rm,
  symlink,
  writeFile,
} = require("node:fs/promises");
const path = require("node:path");

const { OCR_INSTALL_MARKER_FILE } = require("./simple-page-defaults.cjs");
const { runtimeOverrideEnv } = require("./simple-page-child-env.cjs");
const { clampProgressRatio } = require("./simple-page-progress.cjs");
const {
  buildOcrRuntimeEnv,
  buildPaddleOcrImportCheckScript,
  buildPaddleOcrImportFailureMessage,
  isPaddleNativeDllLoadFailureText,
  isOcrGpuRequested,
  resolveBootstrapPython,
  resolveOcrDeviceLabel,
  resolveOcrGpuBackend,
  resolveOcrInstallBatchLabel,
  resolveOcrInstallSignature,
  resolveOcrPipInstallBatches,
  resolveOcrPipCacheDir,
  resolveOcrPythonPackageDir,
  resolveOcrRuntimeDir,
  resolveOcrRuntimeVariant,
  resolveOcrTempDir,
  resolveOcrVenvDir,
  resolvePaddlexCacheAliasRoot,
  resolvePaddlexCacheHome,
  resolvePaddleOcrImportCheckTimeoutMs,
  resolveRealPaddlexCacheHome,
  resolveVenvPythonPath,
  isWindowsRocmOcrRuntimePathShortEnough,
  shouldUseWindowsShortRocmOcrLayout,
  summarizeOcrErrorMessage,
  summarizeOcrInstallBatches,
} = require("./simple-page-ocr-runtime-config.cjs");
const {
  startTaskProgressMonitor,
} = require("./simple-page-ocr-progress-handlers.cjs");
const {
  ensurePaddleOcrModelAssetsDownloaded,
} = require("./simple-page-model-assets.cjs");
const {
  downloadHfFileWithProgress,
  probeContentLength,
} = require("./simple-page-download-utils.cjs");
const {
  createDetailedError,
  emitRuntimeProgress,
} = require("./simple-page-runtime-common.cjs");
const {
  quoteCommandArg,
  runShellCommand,
} = require("./simple-page-shell-utils.cjs");
const { readPositiveInteger } = require("./simple-page-prompts.cjs");

const DEFAULT_EMBED_PYTHON_VERSION = "3.12.7";
const DEFAULT_GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py";
const DEFAULT_VCREDIST_X64_URL =
  "https://aka.ms/vs/17/release/vc_redist.x64.exe";
const PYTHON_RUNTIME_MARKER_FILE = ".mgt-bootstrap-python.json";

/**
 * @param {RuntimeOptions} options
 */
async function ensurePaddleOcrRuntime(options = {}) {
  /** @type {unknown[]} */
  const diagnostics = [];
  const runtimeDir = resolveOcrRuntimeDir(options);
  const runtimeVariant = resolveOcrRuntimeVariant(options);
  const venvDir = resolveOcrVenvDir(runtimeDir, runtimeVariant, options);
  const venvPython = resolveVenvPythonPath(venvDir);
  const packageDir = resolveOcrPythonPackageDir(runtimeDir, options);
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
      {
        step: "rocm-ocr-runtime-path-too-long",
        runtimeDir,
        packageDir,
      },
    );
  }
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
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(resolveOcrPipCacheDir(runtimeDir, options), { recursive: true });
  await mkdir(resolveOcrTempDir(runtimeDir, options), { recursive: true });
  const cachePaths = await preparePaddlexCacheHome(options, runtimeDir);

  emitRuntimeProgress(
    options,
    "ocr_preparing",
    "Paddle OCR 런타임 확인 중",
    `${resolveOcrDeviceLabel(options)}, ${runtimeVariant}`,
  );
  let importCheck = existsSync(venvPython)
    ? await checkPaddleOcrImport(venvPython, options, {
        runtimeDir,
        includePackageDir: false,
        ...cachePaths,
      })
    : { ok: false, message: "venv python is missing" };
  if (existsSync(venvPython) && importCheck.ok) {
    if (hasOcrInstallMarker(packageDir, runtimeVariant, options)) {
      return finalizePaddleOcrRuntime(options, {
        runtimeDir,
        runtimeVariant,
        packageDir,
        pythonPath: venvPython,
        prepared: true,
        usesTargetPackageDir: false,
        diagnostics,
        ...cachePaths,
      });
    }
    diagnostics.push({
      step: "venv-runtime-signature-mismatch",
      runtimeDir,
      runtimeVariant,
      packageDir,
      pythonPath: venvPython,
      expectedSignature: resolveOcrInstallSignature(options),
    });
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
    await rm(venvDir, { recursive: true, force: true });
    await rm(packageDir, { recursive: true, force: true });
    importCheck = {
      ok: false,
      message: "OCR runtime package signature changed",
    };
  }

  let bootstrapPython = resolveBootstrapPython(options);
  if (!bootstrapPython) {
    bootstrapPython = await ensureManagedBootstrapPython(options, runtimeDir);
  }
  ensureEmbeddedPythonPackagePath(bootstrapPython, packageDir, runtimeDir);
  importCheck = !existsSync(venvPython)
    ? await checkPaddleOcrImport(bootstrapPython, options, {
        runtimeDir,
        packageDir,
        includePackageDir: true,
        ...cachePaths,
      })
    : importCheck;
  if (!existsSync(venvPython) && importCheck.ok) {
    if (hasOcrInstallMarker(packageDir, runtimeVariant, options)) {
      return finalizePaddleOcrRuntime(options, {
        runtimeDir,
        runtimeVariant,
        packageDir,
        pythonPath: bootstrapPython,
        prepared: true,
        usesTargetPackageDir: true,
        diagnostics: [{ step: "embedded-python-ready", packageDir }],
        ...cachePaths,
      });
    }
    diagnostics.push({
      step: "target-runtime-signature-mismatch",
      runtimeDir,
      runtimeVariant,
      packageDir,
      pythonPath: bootstrapPython,
      expectedSignature: resolveOcrInstallSignature(options),
    });
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
    await rm(packageDir, { recursive: true, force: true });
    ensureEmbeddedPythonPackagePath(bootstrapPython, packageDir, runtimeDir);
    importCheck = {
      ok: false,
      message: "OCR runtime package signature changed",
    };
  }

  const targetInstallLooksBroken =
    hasOcrInstallMarker(packageDir, runtimeVariant, options) ||
    hasExpectedOcrPackages(packageDir, options);
  if (targetInstallLooksBroken && !importCheck.ok) {
    diagnostics.push({
      step: "installed-runtime-verification-failed",
      runtimeDir,
      runtimeVariant,
      packageDir,
      pythonPath: existsSync(venvPython) ? venvPython : bootstrapPython,
      importError: importCheck.message,
    });
    await rm(packageDir, { recursive: true, force: true });
    ensureEmbeddedPythonPackagePath(bootstrapPython, packageDir, runtimeDir);
  }

  if (
    !isTruthy(
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_AUTO_INSTALL", options) ??
        "true",
    )
  ) {
    throw new Error(
      "PaddleOCR-VL runtime is not installed and automatic installation is disabled.",
    );
  }

  diagnostics.push({ step: "bootstrap-python", pythonPath: bootstrapPython });
  if (!existsSync(venvPython)) {
    try {
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
      await runShellCommand(
        `${quoteCommandArg(bootstrapPython)} -m venv ${quoteCommandArg(venvDir)}`,
        {
          timeoutMs: 180000,
          env: buildOcrRuntimeEnv(options, {
            runtimeDir,
            includePackageDir: false,
            ...cachePaths,
          }),
          signal: options.abortSignal,
        },
      );
      diagnostics.push({ step: "venv-created", venvDir });
    } catch (error) {
      diagnostics.push({
        step: "venv-create-failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const installBatches = resolveOcrPipInstallBatches(options);
  const packageSummary = summarizeOcrInstallBatches(installBatches, options);
  let installPython = existsSync(venvPython) ? venvPython : bootstrapPython;
  let targetDir = existsSync(venvPython) ? null : packageDir;
  try {
    emitRuntimeProgress(
      options,
      "ocr_downloading",
      "Paddle OCR 패키지 다운로드/설치 중",
      packageSummary,
      {
        progressMode: "log-only",
        installLogLine: "Paddle OCR 패키지 설치를 시작합니다.",
      },
    );
    await installOcrPythonPackages(
      installPython,
      installBatches,
      targetDir,
      options,
      runtimeDir,
    );
  } catch (error) {
    if (installPython === bootstrapPython) {
      throw error;
    }
    diagnostics.push({
      step: "venv-pip-install-failed",
      message: error instanceof Error ? error.message : String(error),
    });
    installPython = bootstrapPython;
    targetDir = packageDir;
    ensureEmbeddedPythonPackagePath(installPython, packageDir, runtimeDir);
    emitRuntimeProgress(
      options,
      "ocr_downloading",
      "Paddle OCR 패키지 재설치 중",
      packageSummary,
      {
        progressMode: "log-only",
        installLogLine:
          "가상환경 설치에 실패해 내장 Python 경로로 다시 설치합니다.",
      },
    );
    await installOcrPythonPackages(
      installPython,
      installBatches,
      targetDir,
      options,
      runtimeDir,
    );
  }
  diagnostics.push({
    step: "pip-installed",
    installBatches,
    targetDir,
    runtimeVariant,
  });

  emitRuntimeProgress(
    options,
    "ocr_downloading",
    "Paddle OCR 설치 검증 중",
    packageSummary,
    {
      progressMode: "indeterminate",
      installLogLine: "Paddle OCR import와 장치 상태를 확인합니다.",
    },
  );
  importCheck = await checkPaddleOcrImport(installPython, options, {
    runtimeDir,
    packageDir,
    includePackageDir: Boolean(targetDir),
    ...cachePaths,
  });
  if (
    !importCheck.ok &&
    isPaddleNativeDllLoadFailureText(summarizeImportCheckFailure(importCheck))
  ) {
    diagnostics.push({
      step: "paddle-native-dll-load-failed",
      runtimeDir,
      runtimeVariant,
      packageDir,
      pythonPath: installPython,
      importError: summarizeImportCheckFailure(importCheck),
    });
    await ensureMicrosoftVisualCppRuntimeForPaddle(options, runtimeDir);
    emitRuntimeProgress(
      options,
      "ocr_downloading",
      "Paddle OCR 설치 재검증 중",
      packageSummary,
      {
        progressMode: "indeterminate",
        installLogLine:
          "Microsoft Visual C++ 런타임 준비 후 Paddle OCR import를 다시 확인합니다.",
      },
    );
    importCheck = await checkPaddleOcrImport(installPython, options, {
      runtimeDir,
      packageDir,
      includePackageDir: Boolean(targetDir),
      ...cachePaths,
    });
  }
  if (!importCheck.ok) {
    throw createOcrRuntimeError(
      buildPaddleOcrImportFailureMessage(
        summarizeImportCheckFailure(importCheck),
        options,
      ),
      {
        step: "post-install-verification-failed",
        runtimeDir,
        runtimeVariant,
        packageDir,
        pythonPath: installPython,
        importError: summarizeImportCheckFailure(importCheck),
      },
      importCheck.error,
    );
  }
  await writeOcrInstallMarker(packageDir, {
    runtimeVariant,
    installBatches,
    targetDir,
    packageSignature: resolveOcrInstallSignature(options),
    installedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
  });

  emitRuntimeProgress(
    options,
    "ocr_downloading",
    "Paddle OCR 설치 완료",
    packageSummary,
    {
      progressMode: "determinate",
      progressPercent: 1,
      installLogLine: "Paddle OCR 설치가 완료되었습니다.",
    },
  );

  return finalizePaddleOcrRuntime(options, {
    runtimeDir,
    runtimeVariant,
    packageDir,
    pythonPath: installPython,
    prepared: true,
    usesTargetPackageDir: Boolean(targetDir),
    diagnostics,
    ...cachePaths,
  });
}

/**
 * @param {RuntimeOptions} options
 * @param {string} runtimeDir
 * @returns {Promise<string>}
 */
async function ensureManagedBootstrapPython(options = {}, runtimeDir) {
  if (process.platform !== "win32") {
    throw new Error(
      "PaddleOCR-VL bbox provider needs Python. Install Python 3 or set MANGA_TRANSLATOR_OCR_PYTHON.",
    );
  }

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
  const bootstrapRoot = path.join(runtimeDir, "bootstrap-python");
  const pythonDir = path.join(bootstrapRoot, `python-${version}`);
  const pythonExe = path.join(pythonDir, "python.exe");
  const markerPath = path.join(pythonDir, PYTHON_RUNTIME_MARKER_FILE);

  if (
    isCurrentManagedBootstrapPython(pythonExe, markerPath, {
      version,
      pythonUrl,
      getPipUrl,
    })
  ) {
    sanitizeStandaloneEmbeddedPythonPathFile(pythonDir);
    return pythonExe;
  }

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

  await rm(pythonDir, { recursive: true, force: true });
  await mkdir(pythonDir, { recursive: true });
  const downloadsDir = path.join(runtimeDir, ".downloads", "python");
  await mkdir(downloadsDir, { recursive: true });
  const zipName =
    path.basename(new URL(pythonUrl).pathname) ||
    `python-${version}-embed-amd64.zip`;
  const zipPath = path.join(downloadsDir, zipName);
  const getPipPath = path.join(downloadsDir, "get-pip.py");

  await downloadGenericFileWithRuntimeProgress(
    {
      label: "Paddle OCR Python",
      file: zipName,
      url: pythonUrl,
      destination: zipPath,
      progressTitle: "Paddle OCR Python 다운로드 중",
      completeTitle: "Paddle OCR Python 다운로드 완료",
    },
    options,
  );

  emitRuntimeProgress(
    options,
    "ocr_downloading",
    "Paddle OCR Python 압축 해제 중",
    zipName,
    {
      progressMode: "indeterminate",
      installLogLine: "OCR용 Python 압축을 앱 데이터 폴더에 풀고 있습니다.",
    },
  );
  await extractZipWithPowerShell(zipPath, pythonDir, options);
  if (!existsSync(pythonExe)) {
    throw createOcrRuntimeError(
      "OCR용 Python 압축을 풀었지만 python.exe를 찾지 못했습니다.",
      {
        pythonDir,
        pythonUrl,
      },
    );
  }
  sanitizeStandaloneEmbeddedPythonPathFile(pythonDir);

  await downloadGenericFileWithRuntimeProgress(
    {
      label: "Paddle OCR pip",
      file: "get-pip.py",
      url: getPipUrl,
      destination: getPipPath,
      progressTitle: "Paddle OCR pip 다운로드 중",
      completeTitle: "Paddle OCR pip 다운로드 완료",
    },
    options,
  );

  emitRuntimeProgress(
    options,
    "ocr_downloading",
    "Paddle OCR pip 설치 중",
    `Python ${version}`,
    {
      progressMode: "indeterminate",
      installLogLine: "OCR용 Python에 pip를 설치합니다.",
    },
  );
  await runShellCommand(
    `${quoteCommandArg(pythonExe)} ${quoteCommandArg(getPipPath)} --no-warn-script-location`,
    {
      timeoutMs: 300000,
      env: buildBootstrapPythonEnv(runtimeDir, options),
      signal: options.abortSignal,
      onOutput: (line) =>
        emitRuntimeProgress(
          options,
          "ocr_downloading",
          "Paddle OCR pip 설치 중",
          `Python ${version}`,
          {
            progressMode: "indeterminate",
            installLogLine: line,
          },
        ),
    },
  );

  await writeFile(
    markerPath,
    `${JSON.stringify(
      {
        version,
        pythonUrl,
        getPipUrl,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
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
  return pythonExe;
}

/**
 * @param {RuntimeOptions} options
 * @param {string} runtimeDir
 * @returns {Promise<void>}
 */
async function ensureMicrosoftVisualCppRuntimeForPaddle(
  options = {},
  runtimeDir,
) {
  if (process.platform !== "win32") {
    return;
  }
  if (
    !isTruthy(
      runtimeOverrideEnv(
        "MANGA_TRANSLATOR_OCR_AUTO_INSTALL_VCREDIST",
        options,
      ) ?? "true",
    )
  ) {
    emitRuntimeProgress(
      options,
      "ocr_downloading",
      "Microsoft Visual C++ 런타임 필요",
      "자동 설치가 비활성화되어 있습니다.",
      {
        progressMode: "log-only",
        installLogLine:
          "Paddle 네이티브 DLL 로딩에 필요한 Microsoft Visual C++ 2015-2022 x64 런타임을 설치해야 합니다.",
      },
    );
    return;
  }

  const url = String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_VCREDIST_X64_URL", options) ||
      DEFAULT_VCREDIST_X64_URL,
  ).trim();
  const downloadsDir = path.join(runtimeDir, ".downloads", "vcredist");
  const redistPath = path.join(downloadsDir, "vc_redist.x64.exe");
  await mkdir(downloadsDir, { recursive: true });

  if (!existsSync(redistPath)) {
    const totalBytes = await probeContentLength(url, options.abortSignal).catch(
      () => 0,
    );
    await downloadHfFileWithProgress(
      {
        label: "Microsoft Visual C++ 런타임",
        file: "vc_redist.x64.exe",
        url,
        destination: redistPath,
        progressPhase: "ocr_downloading",
        progressTitle: "Microsoft Visual C++ 런타임 다운로드 중",
        completeTitle: "Microsoft Visual C++ 런타임 다운로드 완료",
      },
      options,
      { totalBytes },
    );
  }

  emitRuntimeProgress(
    options,
    "ocr_downloading",
    "Microsoft Visual C++ 런타임 설치 중",
    "Paddle 네이티브 DLL 로딩에 필요한 x64 런타임을 준비합니다.",
    {
      progressMode: "indeterminate",
      installLogLine:
        "Microsoft Visual C++ 2015-2022 x64 런타임을 설치/복구합니다. Windows가 권한 확인을 요청하면 허용해 주세요.",
    },
  );

  try {
    await runShellCommand(
      `${quoteCommandArg(redistPath)} /install /quiet /norestart`,
      {
        timeoutMs: 600000,
        env: buildOcrRuntimeEnv(options, {
          runtimeDir,
          includePackageDir: false,
        }),
        signal: options.abortSignal,
        successCodes: [0, 3010, 1638],
        failureMessage: "Microsoft Visual C++ runtime installer failed.",
      },
    );
    emitRuntimeProgress(
      options,
      "ocr_downloading",
      "Microsoft Visual C++ 런타임 준비 완료",
      "Paddle OCR import를 다시 확인합니다.",
      {
        progressMode: "log-only",
        installLogLine: "Microsoft Visual C++ 런타임 준비가 완료되었습니다.",
      },
    );
  } catch (error) {
    emitRuntimeProgress(
      options,
      "ocr_downloading",
      "Microsoft Visual C++ 런타임 설치 실패",
      error instanceof Error ? error.message : String(error),
      {
        progressMode: "log-only",
        installLogLine:
          "Microsoft Visual C++ 런타임 자동 설치에 실패했습니다. 관리자 권한 또는 Windows 정책 때문에 막혔을 수 있습니다.",
      },
    );
  }
}

/**
 * @param {ImportCheckResult} importCheck
 * @returns {string}
 */
function summarizeImportCheckFailure(importCheck) {
  return summarizeOcrErrorMessage(
    importCheck?.error || importCheck?.message || "",
  );
}

/**
 * @param {string} pythonExe
 * @param {string} markerPath
 * @param {ManagedPythonMarker} expected
 * @returns {boolean}
 */
function isCurrentManagedBootstrapPython(pythonExe, markerPath, expected) {
  try {
    if (!existsSync(pythonExe)) {
      return false;
    }
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    return (
      marker?.version === expected.version &&
      marker?.pythonUrl === expected.pythonUrl &&
      marker?.getPipUrl === expected.getPipUrl
    );
  } catch (_error) {
    return false;
  }
}

/**
 * @param {RuntimeDownloadTask} task
 * @param {RuntimeOptions} [options]
 * @returns {Promise<void>}
 */
async function downloadGenericFileWithRuntimeProgress(task, options = {}) {
  const totalBytes = await probeContentLength(task.url, options.abortSignal);
  await downloadHfFileWithProgress(
    {
      ...task,
      kind: "runtime",
      progressPhase: "ocr_downloading",
    },
    options,
    {
      totalBytes,
      knownAggregateBytes: 0,
      completedBytes: 0,
    },
  );
}

/**
 * @param {string} zipPath
 * @param {string} destinationDir
 * @param {RuntimeOptions} [options]
 * @returns {Promise<void>}
 */
async function extractZipWithPowerShell(zipPath, destinationDir, options = {}) {
  if (process.platform !== "win32") {
    throw new Error(
      "ZIP extraction for managed OCR Python is currently supported on Windows only.",
    );
  }
  const command = [
    "powershell.exe",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    quoteCommandArg(
      `Expand-Archive -LiteralPath '${escapePowerShellSingleQuoted(zipPath)}' -DestinationPath '${escapePowerShellSingleQuoted(destinationDir)}' -Force`,
    ),
  ].join(" ");
  await runShellCommand(command, {
    timeoutMs: 300000,
    env: buildBootstrapPythonEnv(
      path.dirname(path.dirname(destinationDir)),
      options,
    ),
    signal: options.abortSignal,
  });
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function escapePowerShellSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * @param {string} runtimeDir
 * @param {RuntimeOptions} [options]
 * @returns {NodeJS.ProcessEnv}
 */
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
  };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  delete env.PYTHONUSERBASE;
  return env;
}

/**
 * @param {string} outputDir
 * @returns {void}
 */
function sanitizeStandaloneEmbeddedPythonPathFile(outputDir) {
  let pthName;
  try {
    pthName =
      readdirSync(outputDir).find((name) => /^python\d+._pth$/i.test(name)) ||
      "";
  } catch (_error) {
    return;
  }
  if (!pthName) {
    return;
  }

  const pthPath = path.join(outputDir, pthName);
  try {
    const text = readFileSync(pthPath, "utf8");
    const sanitized = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "#import site" || trimmed === "import site") {
        continue;
      }
      if (isManagedOcrPackagePathLine(trimmed, outputDir, "")) {
        continue;
      }
      if (!trimmed && sanitized[sanitized.length - 1] === "") {
        continue;
      }
      sanitized.push(line);
    }
    while (sanitized.length > 0 && sanitized[sanitized.length - 1] === "") {
      sanitized.pop();
    }
    if (sanitized.length > 0) {
      sanitized.push("");
    }
    sanitized.push("import site");
    const nextText = `${sanitized.join("\n")}\n`;
    if (nextText !== text) {
      writeFileSync(pthPath, nextText, "utf8");
    }
  } catch (_error) {
    // The OCR install path can still fall back to a venv/target install.
  }
}

/**
 * @param {RuntimeOptions} options
 * @param {OcrRuntimeLayout} runtime
 */
async function finalizePaddleOcrRuntime(options, runtime) {
  await ensurePaddleOcrModelAssetsDownloaded(options, runtime);
  return runtime;
}

/**
 * @param {RuntimeOptions} options
 * @param {string} runtimeDir
 * @returns {Promise<OcrRuntimeLayout>}
 */
async function preparePaddlexCacheHome(options, runtimeDir) {
  const realPaddlexCacheHome = resolveRealPaddlexCacheHome(runtimeDir);
  const paddlexCacheHome = resolvePaddlexCacheHome(runtimeDir, options);
  await mkdir(realPaddlexCacheHome, { recursive: true });
  if (
    path.resolve(paddlexCacheHome).toLowerCase() ===
    path.resolve(realPaddlexCacheHome).toLowerCase()
  ) {
    return { paddlexCacheHome: realPaddlexCacheHome, realPaddlexCacheHome };
  }

  try {
    await mkdir(path.dirname(paddlexCacheHome), { recursive: true });
    await replaceStalePaddlexCacheAlias(
      paddlexCacheHome,
      realPaddlexCacheHome,
      options,
    );
    if (!existsSync(paddlexCacheHome)) {
      await symlink(realPaddlexCacheHome, paddlexCacheHome, "junction");
    }
    emitRuntimeProgress(
      options,
      "ocr_preparing",
      "Paddle OCR 캐시 경로 준비 중",
      "한글 경로 호환을 위해 안전한 캐시 별칭을 사용합니다.",
      {
        progressMode: "log-only",
        installLogLine: `Paddle OCR 캐시 별칭: ${paddlexCacheHome}`,
      },
    );
    return { paddlexCacheHome, realPaddlexCacheHome };
  } catch (error) {
    emitRuntimeProgress(
      options,
      "ocr_preparing",
      "Paddle OCR 캐시 경로 별칭 실패",
      "원래 캐시 경로로 계속 진행합니다.",
      {
        progressMode: "log-only",
        installLogLine: `Paddle OCR 캐시 별칭 생성 실패: ${error instanceof Error ? error.message : String(error)}`,
      },
    );
    return { paddlexCacheHome: realPaddlexCacheHome, realPaddlexCacheHome };
  }
}

/**
 * @param {string} aliasPath
 * @param {string} targetPath
 * @param {RuntimeOptions} [options]
 * @returns {Promise<void>}
 */
async function replaceStalePaddlexCacheAlias(
  aliasPath,
  targetPath,
  options = {},
) {
  let stats;
  try {
    stats = await lstat(aliasPath);
  } catch (_error) {
    return;
  }

  if (stats.isSymbolicLink()) {
    try {
      const currentTarget = await readlink(aliasPath);
      if (
        path.resolve(path.dirname(aliasPath), currentTarget).toLowerCase() ===
        path.resolve(targetPath).toLowerCase()
      ) {
        return;
      }
    } catch (_error) {
      // Recreate broken links below.
    }
  }

  if (!isSafePaddlexCacheAliasPath(aliasPath, options)) {
    throw new Error(`Unsafe Paddle OCR cache alias path: ${aliasPath}`);
  }
  await rm(aliasPath, { recursive: true, force: true });
}

/**
 * @param {string} aliasPath
 * @param {RuntimeOptions} [options]
 * @returns {boolean}
 */
function isSafePaddlexCacheAliasPath(aliasPath, options = {}) {
  const root = path.resolve(resolvePaddlexCacheAliasRoot(options));
  const resolved = path.resolve(aliasPath);
  const relative = path.relative(root, resolved);
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

/**
 * @param {string | null | undefined} pythonPath
 * @param {string} packageDir
 * @param {string | null} [runtimeDir]
 */
function ensureEmbeddedPythonPackagePath(
  pythonPath,
  packageDir,
  runtimeDir = null,
) {
  if (!pythonPath || path.basename(pythonPath).toLowerCase() !== "python.exe") {
    return;
  }
  const pythonDir = path.dirname(path.resolve(pythonPath));
  let pthName;
  try {
    pthName =
      readdirSync(pythonDir).find((name) => /^python\d+._pth$/i.test(name)) ||
      "";
  } catch (_error) {
    return;
  }
  if (!pthName) {
    return;
  }
  const pthPath = path.join(pythonDir, pthName);
  const normalizedPackageDir = path.resolve(packageDir);
  try {
    const text = readFileSync(pthPath, "utf8");
    const normalizedRuntimeDir = runtimeDir ? path.resolve(runtimeDir) : "";
    const lines = text.split(/\r?\n/);
    const nextLines = lines
      .filter(
        (line) =>
          !isManagedOcrPackagePathLine(line, pythonDir, normalizedRuntimeDir),
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
    // Packaged Python may be read-only; the venv/target install path can still work.
  }
}

/**
 * @param {unknown} line
 * @param {string} pythonDir
 * @param {string} runtimeDir
 * @returns {boolean}
 */
function isManagedOcrPackagePathLine(line, pythonDir, runtimeDir) {
  const raw = String(line ?? "").trim();
  if (!raw || raw.startsWith("#")) {
    return false;
  }
  let resolved;
  try {
    resolved = path.resolve(pythonDir, raw);
  } catch (_error) {
    return false;
  }
  const base = path.basename(resolved);
  const normalized = resolved.replace(/\\/g, "/").toLowerCase();
  const normalizedRuntimeDir = runtimeDir
    ? path.resolve(runtimeDir).replace(/\\/g, "/").toLowerCase()
    : "";
  const isManagedPackageDir =
    base.startsWith("python-packages") ||
    (base === "p" &&
      normalizedRuntimeDir &&
      normalized.startsWith(normalizedRuntimeDir));
  if (!isManagedPackageDir) {
    return false;
  }
  return (
    (normalizedRuntimeDir && normalized.startsWith(normalizedRuntimeDir)) ||
    normalized.includes("/manga-gemma-translator/ocr-runtime/") ||
    normalized.includes("/mgt-ocr-runtime/") ||
    normalized.includes("/.tmp/ocr-runtime/")
  );
}

/**
 * @param {string} pythonPath
 * @param {string[][]} installBatches
 * @param {string | null} targetDir
 * @param {RuntimeOptions} options
 * @param {string | null | undefined} runtimeDir
 * @returns {Promise<void>}
 */
async function installOcrPythonPackages(
  pythonPath,
  installBatches,
  targetDir,
  options,
  runtimeDir,
) {
  const runtimeRoot = runtimeDir || resolveOcrRuntimeDir(options);
  const pipCacheDir = resolveOcrPipCacheDir(runtimeRoot, options);
  const tempDir = resolveOcrTempDir(runtimeRoot, options);
  await mkdir(pipCacheDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });
  const monitor = startTaskProgressMonitor(options, {
    phase: "ocr_downloading",
    progressText: "Paddle OCR 패키지 다운로드/설치 중",
    detailPrefix: summarizeOcrInstallBatches(installBatches, options),
    startPercent: 0.04,
    endPercent: 0.86,
  });
  try {
    const pipProgressArgs = `--cache-dir ${quoteCommandArg(pipCacheDir)} --progress-bar raw`;
    const pipBuildEnv = buildOcrRuntimeEnv(options, {
      runtimeDir: runtimeRoot,
      includePackageDir: false,
    });
    if (targetDir) {
      await mkdir(targetDir, { recursive: true });
    }
    const pipInstallEnv = buildOcrRuntimeEnv(options, {
      runtimeDir: runtimeRoot,
      packageDir: targetDir || undefined,
      includePackageDir: Boolean(targetDir),
    });
    monitor.setStep("pip/build 도구 업데이트", 0.04, 0.1);
    await runShellCommand(
      buildOcrPipBuildToolUpgradeCommand(pythonPath, pipProgressArgs),
      {
        timeoutMs: 300000,
        env: pipBuildEnv,
        signal: options.abortSignal,
        onOutput: (line) => monitor.log(line),
      },
    );
    await runShellCommand(buildOcrPythonBuildToolCheckCommand(pythonPath), {
      timeoutMs: 60000,
      env: pipBuildEnv,
      signal: options.abortSignal,
      onOutput: (line) => monitor.log(line),
      failureMessage:
        "OCR Python build tooling check failed after installing pip/setuptools/wheel.",
    });
    monitor.completeStep("pip/build 도구 업데이트 완료");
    const batchRanges = resolveOcrInstallBatchProgressRanges(
      installBatches,
      0.1,
      0.86,
    );
    for (let index = 0; index < installBatches.length; index += 1) {
      const packages = installBatches[index];
      const range = batchRanges[index] || { start: 0.1, end: 0.86 };
      const batchLabel = resolveOcrInstallBatchLabel(packages, options);
      monitor.setStep(
        [`패키지 설치 ${index + 1}/${installBatches.length}`, batchLabel]
          .filter(Boolean)
          .join(": "),
        range.start,
        range.end,
      );
      await runShellCommand(
        buildOcrPipInstallCommand(
          pythonPath,
          packages,
          targetDir,
          options,
          pipProgressArgs,
        ),
        {
          timeoutMs:
            readPositiveInteger(
              runtimeOverrideEnv(
                "MANGA_TRANSLATOR_OCR_PIP_TIMEOUT_MS",
                options,
              ),
            ) || 1800000,
          env: pipInstallEnv,
          signal: options.abortSignal,
          onOutput: (line) => monitor.log(line),
        },
      );
      monitor.completeStep(
        `패키지 설치 ${index + 1}/${installBatches.length} 완료`,
      );
    }
  } finally {
    monitor.stop();
  }
}

/**
 * @param {string} pythonPath
 * @param {string} [pipProgressArgs]
 * @returns {string}
 */
function buildOcrPipBuildToolUpgradeCommand(pythonPath, pipProgressArgs = "") {
  return [
    quoteCommandArg(pythonPath),
    "-m pip install --upgrade",
    pipProgressArgs,
    "pip",
    "setuptools",
    "wheel",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * @param {string} pythonPath
 * @returns {string}
 */
function buildOcrPythonBuildToolCheckCommand(pythonPath) {
  return `${quoteCommandArg(pythonPath)} -c ${quoteCommandArg("import pip, setuptools, wheel; import setuptools.build_meta; print('python build tooling ok')")}`;
}

/**
 * @param {string} pythonPath
 * @param {string[]} packages
 * @param {string | null} targetDir
 * @param {RuntimeOptions} [options]
 * @param {string} [pipProgressArgs]
 * @returns {string}
 */
function buildOcrPipInstallCommand(
  pythonPath,
  packages,
  targetDir,
  options = {},
  pipProgressArgs = "",
) {
  const extraPipArgs = resolveOcrPipInstallExtraArgs(packages, options)
    .map(quoteCommandArg)
    .join(" ");
  return [
    quoteCommandArg(pythonPath),
    "-m pip install --upgrade",
    pipProgressArgs,
    extraPipArgs,
    targetDir ? `--target ${quoteCommandArg(targetDir)}` : "",
    (Array.isArray(packages) ? packages : []).map(quoteCommandArg).join(" "),
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * @param {string[]} packages
 * @param {RuntimeOptions} [options]
 * @returns {string[]}
 */
function resolveOcrPipInstallExtraArgs(packages, options = {}) {
  const texts = Array.isArray(packages)
    ? packages.map((item) => String(item || "").toLowerCase())
    : [];

  const containsSourceArchive = texts.some((text) =>
    /\.(?:tar\.gz|zip)(?:[?#].*)?$/.test(text),
  );
  const containsRocmSdist = texts.some(isAmdRocmMetaPackageText);
  const containsRocmTorchWheel = texts.some(isAmdRocmTorchWheelText);
  const isRocmTransformersBackend =
    resolveOcrGpuBackend(options) === "rocm-transformers";
  /** @type {string[]} */
  const args = [];

  if (
    containsRocmSdist ||
    (isRocmTransformersBackend && containsSourceArchive)
  ) {
    args.push("--no-build-isolation");
  }

  if (
    isRocmTransformersBackend &&
    (containsRocmSdist || containsRocmTorchWheel)
  ) {
    args.push("--no-deps");
  }

  return args;
}

/**
 * @param {unknown} text
 * @returns {boolean}
 */
function isAmdRocmMetaPackageText(text) {
  return /(?:^|[/\\])rocm-\d+(?:\.\d+)*\.tar\.gz(?:[?#].*)?$/i.test(
    String(text ?? ""),
  );
}

/**
 * @param {unknown} text
 * @returns {boolean}
 */
function isAmdRocmTorchWheelText(text) {
  return /(?:^|[/\\])(?:torch|torchaudio|torchvision)-[^/\\]*rocm[^/\\]*\.whl(?:[?#].*)?$/i.test(
    String(text ?? ""),
  );
}

/**
 * @param {string[][]} installBatches
 * @param {number} startPercent
 * @param {number} endPercent
 * @returns {ProgressRange[]}
 */
function resolveOcrInstallBatchProgressRanges(
  installBatches,
  startPercent,
  endPercent,
) {
  const start = clampProgressRatio(startPercent, 0);
  const end = Math.max(start, clampProgressRatio(endPercent, start));
  const batches = Array.isArray(installBatches) ? installBatches : [];
  if (batches.length === 0) {
    return [];
  }

  const weights = batches.map((packages, index) => {
    const packageText = Array.isArray(packages)
      ? packages.join(" ").toLowerCase()
      : "";
    if (packageText.includes("safetensors")) {
      return batches.length > 1 ? 0.04 : 1;
    }
    if (packageText.includes("paddlepaddle")) {
      return batches.length > 1 ? 0.36 : 1;
    }
    if (packageText.includes("rocm_sdk") || packageText.includes("torch-")) {
      return batches.length > 1 ? 0.36 : 1;
    }
    if (packageText.includes("paddleocr") || packageText.includes("paddlex")) {
      return batches.length > 1 ? 0.64 : 1;
    }
    return 1 + index * 0;
  });
  const totalWeight =
    weights.reduce((sum, value) => sum + Math.max(0.01, value), 0) || 1;
  let cursor = start;
  return batches.map((_packages, index) => {
    const isLast = index === batches.length - 1;
    const next = isLast
      ? end
      : cursor + (end - start) * (Math.max(0.01, weights[index]) / totalWeight);
    const range = { start: cursor, end: next };
    cursor = next;
    return range;
  });
}

/**
 * @param {string} pythonPath
 * @param {RuntimeOptions} [options]
 */
async function canImportPaddleOcr(pythonPath, options = {}) {
  return (await checkPaddleOcrImport(pythonPath, options)).ok;
}

/**
 * @param {string} pythonPath
 * @param {RuntimeOptions} [options]
 * @param {OcrRuntimeLayout | null} [runtime]
 * @returns {Promise<ImportCheckResult>}
 */
async function checkPaddleOcrImport(pythonPath, options = {}, runtime = null) {
  try {
    await runShellCommand(
      `${quoteCommandArg(pythonPath)} -c ${quoteCommandArg(buildPaddleOcrImportCheckScript(options))}`,
      {
        timeoutMs: resolvePaddleOcrImportCheckTimeoutMs(options),
        env: buildOcrRuntimeEnv(options, {
          runtimeDir: runtime?.runtimeDir || resolveOcrRuntimeDir(options),
          packageDir: runtime?.packageDir,
          includePackageDir: runtime?.includePackageDir,
        }),
        signal: options.abortSignal,
        timeoutMessage: "Paddle OCR runtime verification timed out.",
      },
    );
    return { ok: true, message: "" };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      error,
    };
  }
}

/**
 * @param {string} message
 * @param {Record<string, unknown>} [detail]
 * @param {unknown} [cause]
 * @returns {Error}
 */
function createOcrRuntimeError(message, detail = {}, cause) {
  return createDetailedError(
    message,
    {
      ...detail,
      nonRetriable: true,
      failureCategory: "ocr-runtime",
    },
    cause,
  );
}

/**
 * @param {string} packageDir
 * @param {string} runtimeVariant
 * @param {RuntimeOptions} [options]
 * @returns {boolean}
 */
function hasOcrInstallMarker(packageDir, runtimeVariant, options = {}) {
  try {
    const marker = JSON.parse(
      readFileSync(path.join(packageDir, OCR_INSTALL_MARKER_FILE), "utf8"),
    );
    return (
      marker?.runtimeVariant === runtimeVariant &&
      marker?.packageSignature === resolveOcrInstallSignature(options)
    );
  } catch (_error) {
    return false;
  }
}

/**
 * @param {string} packageDir
 * @param {Record<string, unknown>} payload
 * @returns {Promise<void>}
 */
async function writeOcrInstallMarker(packageDir, payload) {
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    path.join(packageDir, OCR_INSTALL_MARKER_FILE),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

/**
 * @param {string} packageDir
 * @param {RuntimeOptions} [options]
 * @returns {boolean}
 */
function hasExpectedOcrPackages(packageDir, options = {}) {
  if (!packageDir || !existsSync(packageDir)) {
    return false;
  }
  const backend = resolveOcrGpuBackend(options);
  if (isOcrGpuRequested(options) && backend === "rocm-transformers") {
    return ["torch", "transformers", "paddleocr"].every((name) =>
      existsSync(path.join(packageDir, name)),
    );
  }
  const required = ["paddle", "paddleocr", "paddlex"];
  if (isOcrGpuRequested(options) && backend === "cuda") {
    required.push("nvidia");
  }
  return required.every((name) => existsSync(path.join(packageDir, name)));
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isTruthy(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(text);
}

module.exports = {
  buildOcrPipBuildToolUpgradeCommand,
  buildOcrPipInstallCommand,
  buildOcrPythonBuildToolCheckCommand,
  canImportPaddleOcr,
  createOcrRuntimeError,
  ensurePaddleOcrRuntime,
  resolveOcrInstallBatchProgressRanges,
  resolveOcrPipInstallExtraArgs,
};
