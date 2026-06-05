const { existsSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { mkdir, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");

const {
  OCR_INSTALL_MARKER_FILE
} = require("./simple-page-defaults.cjs");
const {
  runtimeOverrideEnv
} = require("./simple-page-child-env.cjs");
const {
  clampProgressRatio
} = require("./simple-page-progress.cjs");
const {
  buildOcrRuntimeEnv,
  buildPaddleOcrImportCheckScript,
  buildPaddleOcrImportFailureMessage,
  isOcrGpuRequested,
  resolveBootstrapPython,
  resolveInstallProgressDir,
  resolveOcrDeviceLabel,
  resolveOcrInstallSignature,
  resolveOcrPipInstallBatches,
  resolveOcrPythonPackageDir,
  resolveOcrRuntimeDir,
  resolveOcrRuntimeVariant,
  resolvePaddleOcrImportCheckTimeoutMs,
  resolveVenvPythonPath,
  summarizeOcrInstallBatches
} = require("./simple-page-ocr-runtime-config.cjs");
const {
  startTaskProgressMonitor
} = require("./simple-page-ocr-progress-handlers.cjs");
const {
  ensurePaddleOcrModelAssetsDownloaded
} = require("./simple-page-model-assets.cjs");
const {
  createDetailedError,
  emitRuntimeProgress
} = require("./simple-page-runtime-common.cjs");
const {
  quoteCommandArg,
  runShellCommand
} = require("./simple-page-shell-utils.cjs");
const {
  readPositiveInteger
} = require("./simple-page-prompts.cjs");

async function ensurePaddleOcrRuntime(options = {}) {
  const diagnostics = [];
  const runtimeDir = resolveOcrRuntimeDir(options);
  const runtimeVariant = resolveOcrRuntimeVariant(options);
  const venvDir = path.join(runtimeDir, `.venv-${runtimeVariant}`);
  const venvPython = resolveVenvPythonPath(venvDir);
  const packageDir = resolveOcrPythonPackageDir(runtimeDir, options);
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(path.join(runtimeDir, "pip-cache"), { recursive: true });
  await mkdir(path.join(runtimeDir, "tmp"), { recursive: true });

  emitRuntimeProgress(options, "ocr_preparing", "Paddle OCR 런타임 확인 중", `${resolveOcrDeviceLabel(options)}, ${runtimeVariant}`);
  let importCheck = existsSync(venvPython)
    ? await checkPaddleOcrImport(venvPython, options, { runtimeDir, includePackageDir: false })
    : { ok: false, message: "venv python is missing" };
  if (existsSync(venvPython) && importCheck.ok) {
    if (hasOcrInstallMarker(packageDir, runtimeVariant, options)) {
      return finalizePaddleOcrRuntime(options, { runtimeDir, runtimeVariant, packageDir, pythonPath: venvPython, prepared: true, usesTargetPackageDir: false, diagnostics });
    }
    diagnostics.push({
      step: "venv-runtime-signature-mismatch",
      runtimeDir,
      runtimeVariant,
      packageDir,
      pythonPath: venvPython,
      expectedSignature: resolveOcrInstallSignature(options)
    });
    emitRuntimeProgress(options, "ocr_downloading", "Paddle OCR 런타임 재설치 중", "패키지 구성이 바뀌어 기존 OCR 런타임을 다시 준비합니다.", {
      progressMode: "log-only",
      installLogLine: "기존 OCR 런타임 패키지 구성이 현재 버전과 달라 재설치합니다."
    });
    await rm(venvDir, { recursive: true, force: true });
    await rm(packageDir, { recursive: true, force: true });
    importCheck = { ok: false, message: "OCR runtime package signature changed" };
  }

  const bootstrapPython = resolveBootstrapPython(options);
  if (!bootstrapPython) {
    throw new Error("PaddleOCR-VL bbox provider needs Python. Bundle tools/python/python.exe or set MANGA_TRANSLATOR_OCR_PYTHON.");
  }
  ensureEmbeddedPythonPackagePath(bootstrapPython, packageDir, runtimeDir);
  importCheck = !existsSync(venvPython)
    ? await checkPaddleOcrImport(bootstrapPython, options, { runtimeDir, packageDir, includePackageDir: true })
    : importCheck;
  if (!existsSync(venvPython) && importCheck.ok) {
    if (hasOcrInstallMarker(packageDir, runtimeVariant, options)) {
      return finalizePaddleOcrRuntime(options, { runtimeDir, runtimeVariant, packageDir, pythonPath: bootstrapPython, prepared: true, usesTargetPackageDir: true, diagnostics: [{ step: "embedded-python-ready", packageDir }] });
    }
    diagnostics.push({
      step: "target-runtime-signature-mismatch",
      runtimeDir,
      runtimeVariant,
      packageDir,
      pythonPath: bootstrapPython,
      expectedSignature: resolveOcrInstallSignature(options)
    });
    emitRuntimeProgress(options, "ocr_downloading", "Paddle OCR 런타임 재설치 중", "패키지 구성이 바뀌어 기존 OCR 런타임을 다시 준비합니다.", {
      progressMode: "log-only",
      installLogLine: "기존 OCR 런타임 패키지 구성이 현재 버전과 달라 재설치합니다."
    });
    await rm(packageDir, { recursive: true, force: true });
    ensureEmbeddedPythonPackagePath(bootstrapPython, packageDir, runtimeDir);
    importCheck = { ok: false, message: "OCR runtime package signature changed" };
  }

  const targetInstallLooksBroken = hasOcrInstallMarker(packageDir, runtimeVariant, options) || hasExpectedOcrPackages(packageDir, options);
  if (targetInstallLooksBroken && !importCheck.ok) {
    diagnostics.push({
      step: "installed-runtime-verification-failed",
      runtimeDir,
      runtimeVariant,
      packageDir,
      pythonPath: existsSync(venvPython) ? venvPython : bootstrapPython,
      importError: importCheck.message
    });
    await rm(packageDir, { recursive: true, force: true });
    ensureEmbeddedPythonPackagePath(bootstrapPython, packageDir, runtimeDir);
  }

  if (!isTruthy(runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_AUTO_INSTALL", options) ?? "true")) {
    throw new Error("PaddleOCR-VL runtime is not installed and automatic installation is disabled.");
  }

  diagnostics.push({ step: "bootstrap-python", pythonPath: bootstrapPython });
  if (!existsSync(venvPython)) {
    try {
      emitRuntimeProgress(options, "ocr_downloading", "Paddle OCR Python 환경 생성 중", runtimeDir, {
        progressMode: "log-only",
        installLogLine: "Python 가상환경을 생성합니다."
      });
      await runShellCommand(`${quoteCommandArg(bootstrapPython)} -m venv ${quoteCommandArg(venvDir)}`, {
        timeoutMs: 180000,
        env: buildOcrRuntimeEnv(options, { runtimeDir, includePackageDir: false }),
        signal: options.abortSignal
      });
      diagnostics.push({ step: "venv-created", venvDir });
    } catch (error) {
      diagnostics.push({
        step: "venv-create-failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const installBatches = resolveOcrPipInstallBatches(options);
  const packageSummary = summarizeOcrInstallBatches(installBatches, options);
  let installPython = existsSync(venvPython) ? venvPython : bootstrapPython;
  let targetDir = existsSync(venvPython) ? null : packageDir;
  try {
    emitRuntimeProgress(options, "ocr_downloading", "Paddle OCR 패키지 다운로드/설치 중", packageSummary, {
      progressMode: "log-only",
      installLogLine: "Paddle OCR 패키지 설치를 시작합니다."
    });
    await installOcrPythonPackages(installPython, installBatches, targetDir, options, runtimeDir);
  } catch (error) {
    if (installPython === bootstrapPython) {
      throw error;
    }
    diagnostics.push({
      step: "venv-pip-install-failed",
      message: error instanceof Error ? error.message : String(error)
    });
    installPython = bootstrapPython;
    targetDir = packageDir;
    ensureEmbeddedPythonPackagePath(installPython, packageDir, runtimeDir);
    emitRuntimeProgress(options, "ocr_downloading", "Paddle OCR 패키지 재설치 중", packageSummary, {
      progressMode: "log-only",
      installLogLine: "가상환경 설치에 실패해 내장 Python 경로로 다시 설치합니다."
    });
    await installOcrPythonPackages(installPython, installBatches, targetDir, options, runtimeDir);
  }
  diagnostics.push({ step: "pip-installed", installBatches, targetDir, runtimeVariant });

  emitRuntimeProgress(options, "ocr_downloading", "Paddle OCR 설치 검증 중", packageSummary, {
    progressMode: "indeterminate",
    installLogLine: "Paddle OCR import와 장치 상태를 확인합니다."
  });
  importCheck = await checkPaddleOcrImport(installPython, options, {
    runtimeDir,
    packageDir,
    includePackageDir: Boolean(targetDir)
  });
  if (!importCheck.ok) {
    throw createOcrRuntimeError(
      buildPaddleOcrImportFailureMessage(importCheck.message, options),
      {
        step: "post-install-verification-failed",
        runtimeDir,
        runtimeVariant,
        packageDir,
        pythonPath: installPython,
        importError: importCheck.message
      },
      importCheck.error
    );
  }
  await writeOcrInstallMarker(packageDir, {
    runtimeVariant,
    installBatches,
    targetDir,
    packageSignature: resolveOcrInstallSignature(options),
    installedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString()
  });

  emitRuntimeProgress(options, "ocr_downloading", "Paddle OCR 설치 완료", packageSummary, {
    progressMode: "determinate",
    progressPercent: 1,
    installLogLine: "Paddle OCR 설치가 완료되었습니다."
  });

  return finalizePaddleOcrRuntime(options, { runtimeDir, runtimeVariant, packageDir, pythonPath: installPython, prepared: true, usesTargetPackageDir: Boolean(targetDir), diagnostics });
}

async function finalizePaddleOcrRuntime(options, runtime) {
  await ensurePaddleOcrModelAssetsDownloaded(options, runtime);
  return runtime;
}

function ensureEmbeddedPythonPackagePath(pythonPath, packageDir, runtimeDir = null) {
  if (!pythonPath || path.basename(pythonPath).toLowerCase() !== "python.exe") {
    return;
  }
  const pythonDir = path.dirname(path.resolve(pythonPath));
  let pthName = "";
  try {
    pthName = readdirSync(pythonDir).find((name) => /^python\d+._pth$/i.test(name)) || "";
  } catch {
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
      .filter((line) => !isManagedOcrPackagePathLine(line, pythonDir, normalizedRuntimeDir))
      .map((line) => line.trim() === "#import site" ? "import site" : line);
    const importSiteIndex = nextLines.findIndex((line) => line.trim() === "import site");
    if (importSiteIndex === -1) {
      nextLines.push(normalizedPackageDir, "import site");
    } else {
      nextLines.splice(importSiteIndex, 0, normalizedPackageDir);
    }
    const nextText = `${nextLines.filter((line, index, array) => index < array.length - 1 || line.trim()).join("\n")}\n`;
    if (nextText !== text) {
      writeFileSync(pthPath, nextText, "utf8");
    }
  } catch {
    // Packaged Python may be read-only; the venv/target install path can still work.
  }
}

function isManagedOcrPackagePathLine(line, pythonDir, runtimeDir) {
  const raw = String(line ?? "").trim();
  if (!raw || raw.startsWith("#")) {
    return false;
  }
  let resolved = raw;
  try {
    resolved = path.resolve(pythonDir, raw);
  } catch {
    return false;
  }
  const base = path.basename(resolved);
  if (!base.startsWith("python-packages")) {
    return false;
  }
  const normalized = resolved.replace(/\\/g, "/").toLowerCase();
  const normalizedRuntimeDir = runtimeDir ? path.resolve(runtimeDir).replace(/\\/g, "/").toLowerCase() : "";
  return (
    (normalizedRuntimeDir && normalized.startsWith(normalizedRuntimeDir)) ||
    normalized.includes("/manga-gemma-translator/ocr-runtime/") ||
    normalized.includes("/mgt-ocr-runtime/") ||
    normalized.includes("/.tmp/ocr-runtime/")
  );
}

async function installOcrPythonPackages(pythonPath, installBatches, targetDir, options, runtimeDir) {
  const progressDir = runtimeDir || targetDir || resolveInstallProgressDir(pythonPath);
  const pipCacheDir = path.join(progressDir, "pip-cache");
  await mkdir(pipCacheDir, { recursive: true });
  await mkdir(path.join(progressDir, "tmp"), { recursive: true });
  const monitor = startTaskProgressMonitor(options, {
    phase: "ocr_downloading",
    progressText: "Paddle OCR 패키지 다운로드/설치 중",
    detailPrefix: summarizeOcrInstallBatches(installBatches, options),
    startPercent: 0.04,
    endPercent: 0.86
  });
  try {
    const pipProgressArgs = `--cache-dir ${quoteCommandArg(pipCacheDir)} --progress-bar raw`;
    monitor.setStep("pip 업데이트", 0.04, 0.1);
    await runShellCommand(`${quoteCommandArg(pythonPath)} -m pip install --upgrade ${pipProgressArgs} pip`, {
      timeoutMs: 300000,
      env: buildOcrRuntimeEnv(options, { runtimeDir, includePackageDir: false }),
      signal: options.abortSignal,
      onOutput: (line) => monitor.log(line)
    });
    monitor.completeStep("pip 업데이트 완료");
    const batchRanges = resolveOcrInstallBatchProgressRanges(installBatches, 0.1, 0.86);
    for (let index = 0; index < installBatches.length; index += 1) {
      const packages = installBatches[index];
      const range = batchRanges[index] || { start: 0.1, end: 0.86 };
      monitor.setStep(`패키지 설치 ${index + 1}/${installBatches.length}`, range.start, range.end);
      await runShellCommand(`${quoteCommandArg(pythonPath)} -m pip install --upgrade ${pipProgressArgs} ${targetDir ? `--target ${quoteCommandArg(targetDir)} ` : ""}${packages.map(quoteCommandArg).join(" ")}`, {
        timeoutMs: readPositiveInteger(runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_PIP_TIMEOUT_MS", options)) || 1800000,
        env: buildOcrRuntimeEnv(options, { runtimeDir, includePackageDir: false }),
        signal: options.abortSignal,
        onOutput: (line) => monitor.log(line)
      });
      monitor.completeStep(`패키지 설치 ${index + 1}/${installBatches.length} 완료`);
    }
  } finally {
    monitor.stop();
  }
}

function resolveOcrInstallBatchProgressRanges(installBatches, startPercent, endPercent) {
  const start = clampProgressRatio(startPercent, 0);
  const end = Math.max(start, clampProgressRatio(endPercent, start));
  const batches = Array.isArray(installBatches) ? installBatches : [];
  if (batches.length === 0) {
    return [];
  }

  const weights = batches.map((packages, index) => {
    const packageText = Array.isArray(packages) ? packages.join(" ").toLowerCase() : "";
    if (packageText.includes("safetensors")) {
      return batches.length > 1 ? 0.04 : 1;
    }
    if (packageText.includes("paddlepaddle")) {
      return batches.length > 1 ? 0.36 : 1;
    }
    if (packageText.includes("paddleocr") || packageText.includes("paddlex")) {
      return batches.length > 1 ? 0.64 : 1;
    }
    return 1 + index * 0;
  });
  const totalWeight = weights.reduce((sum, value) => sum + Math.max(0.01, value), 0) || 1;
  let cursor = start;
  return batches.map((_packages, index) => {
    const isLast = index === batches.length - 1;
    const next = isLast ? end : cursor + (end - start) * (Math.max(0.01, weights[index]) / totalWeight);
    const range = { start: cursor, end: next };
    cursor = next;
    return range;
  });
}

async function canImportPaddleOcr(pythonPath, options = {}) {
  return (await checkPaddleOcrImport(pythonPath, options)).ok;
}

async function checkPaddleOcrImport(pythonPath, options = {}, runtime = null) {
  try {
    await runShellCommand(`${quoteCommandArg(pythonPath)} -c ${quoteCommandArg(buildPaddleOcrImportCheckScript(options))}`, {
      timeoutMs: resolvePaddleOcrImportCheckTimeoutMs(options),
      env: buildOcrRuntimeEnv(options, {
        runtimeDir: runtime?.runtimeDir || resolveOcrRuntimeDir(options),
        packageDir: runtime?.packageDir,
        includePackageDir: runtime?.includePackageDir
      }),
      signal: options.abortSignal,
      timeoutMessage: "Paddle OCR runtime verification timed out."
    });
    return { ok: true, message: "" };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      error
    };
  }
}

function createOcrRuntimeError(message, detail = {}, cause) {
  return createDetailedError(
    message,
    {
      ...detail,
      nonRetriable: true,
      failureCategory: "ocr-runtime"
    },
    cause
  );
}

function hasOcrInstallMarker(packageDir, runtimeVariant, options = {}) {
  try {
    const marker = JSON.parse(readFileSync(path.join(packageDir, OCR_INSTALL_MARKER_FILE), "utf8"));
    return marker?.runtimeVariant === runtimeVariant && marker?.packageSignature === resolveOcrInstallSignature(options);
  } catch {
    return false;
  }
}

async function writeOcrInstallMarker(packageDir, payload) {
  await mkdir(packageDir, { recursive: true });
  await writeFile(path.join(packageDir, OCR_INSTALL_MARKER_FILE), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function hasExpectedOcrPackages(packageDir, options = {}) {
  if (!packageDir || !existsSync(packageDir)) {
    return false;
  }
  const required = ["paddle", "paddleocr", "paddlex"];
  if (isOcrGpuRequested(options)) {
    required.push("nvidia");
  }
  return required.every((name) => existsSync(path.join(packageDir, name)));
}

function isTruthy(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(text);
}

module.exports = {
  canImportPaddleOcr,
  createOcrRuntimeError,
  ensurePaddleOcrRuntime,
  resolveOcrInstallBatchProgressRanges
};
