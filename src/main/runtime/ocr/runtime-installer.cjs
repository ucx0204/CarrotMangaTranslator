// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {{ start: number; end: number }} ProgressRange */

const { mkdir } = require("node:fs/promises");
const { runtimeOverrideEnv } = require("./host-services.cjs");
const { clampProgressRatio } = require("../simple-page-progress.cjs");
const {
  buildOcrRuntimeEnv,
  resolveOcrInstallBatchLabel,
  resolveOcrPipCacheDir,
  resolveOcrRuntimeDir,
  resolveOcrTempDir,
  resolveOcrGpuBackend,
  summarizeOcrInstallBatches,
} = require("../simple-page-ocr-runtime-config.cjs");
const {
  startTaskProgressMonitor,
} = require("../simple-page-ocr-progress-handlers.cjs");
const {
  quoteCommandArg,
  runShellCommand,
} = require("../simple-page-shell-utils.cjs");
const { readPositiveInteger } = require("../simple-page-prompts.cjs");

/**
 * @typedef {{
 *   runtimeRoot: string;
 *   pipProgressArgs: string;
 *   pipBuildEnv: NodeJS.ProcessEnv;
 *   pipInstallEnv: NodeJS.ProcessEnv;
 *   monitor: ReturnType<typeof startTaskProgressMonitor>;
 * }} InstallContext
 */

/** @param {string} pythonPath @param {string[][]} installBatches @param {string | null} targetDir @param {RuntimeOptions} options @param {string | null | undefined} runtimeDir @returns {Promise<void>} */
async function installOcrPythonPackages(
  pythonPath,
  installBatches,
  targetDir,
  options,
  runtimeDir,
) {
  const context = await createInstallContext(
    installBatches,
    targetDir,
    options,
    runtimeDir,
  );
  try {
    await upgradeOcrBuildTools(pythonPath, options, context);
    await installOcrPackageBatches(
      pythonPath,
      installBatches,
      targetDir,
      options,
      context,
    );
  } finally {
    context.monitor.stop();
  }
}

/** @param {string[][]} installBatches @param {string | null} targetDir @param {RuntimeOptions} options @param {string | null | undefined} runtimeDir @returns {Promise<InstallContext>} */
async function createInstallContext(
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
  if (targetDir) {
    await mkdir(targetDir, { recursive: true });
  }
  return {
    runtimeRoot,
    pipProgressArgs: `--cache-dir ${quoteCommandArg(pipCacheDir)} --progress-bar raw`,
    pipBuildEnv: buildOcrRuntimeEnv(options, {
      runtimeDir: runtimeRoot,
      includePackageDir: false,
    }),
    pipInstallEnv: buildOcrRuntimeEnv(options, {
      runtimeDir: runtimeRoot,
      packageDir: targetDir || undefined,
      includePackageDir: Boolean(targetDir),
    }),
    monitor: startTaskProgressMonitor(options, {
      phase: "ocr_downloading",
      progressText: "Paddle OCR 패키지 다운로드/설치 중",
      detailPrefix: summarizeOcrInstallBatches(installBatches, options),
      startPercent: 0.04,
      endPercent: 0.86,
    }),
  };
}

/** @param {string} pythonPath @param {RuntimeOptions} options @param {InstallContext} context @returns {Promise<void>} */
async function upgradeOcrBuildTools(pythonPath, options, context) {
  context.monitor.setStep("pip/build 도구 업데이트", 0.04, 0.1);
  await runShellCommand(
    buildOcrPipBuildToolUpgradeCommand(pythonPath, context.pipProgressArgs),
    {
      timeoutMs: 300000,
      env: context.pipBuildEnv,
      signal: options.abortSignal,
      onOutput: (line) => context.monitor.log(line),
    },
  );
  await runShellCommand(buildOcrPythonBuildToolCheckCommand(pythonPath), {
    timeoutMs: 60000,
    env: context.pipBuildEnv,
    signal: options.abortSignal,
    onOutput: (line) => context.monitor.log(line),
    failureMessage:
      "OCR Python build tooling check failed after installing pip/setuptools/wheel.",
  });
  context.monitor.completeStep("pip/build 도구 업데이트 완료");
}

/** @param {string} pythonPath @param {string[][]} installBatches @param {string | null} targetDir @param {RuntimeOptions} options @param {InstallContext} context @returns {Promise<void>} */
async function installOcrPackageBatches(
  pythonPath,
  installBatches,
  targetDir,
  options,
  context,
) {
  const ranges = resolveOcrInstallBatchProgressRanges(
    installBatches,
    0.1,
    0.86,
  );
  for (let index = 0; index < installBatches.length; index += 1) {
    await installOcrPackageBatch(
      pythonPath,
      installBatches[index],
      targetDir,
      options,
      context,
      index,
      installBatches.length,
      ranges[index] || { start: 0.1, end: 0.86 },
    );
  }
}

/** @param {string} pythonPath @param {string[]} packages @param {string | null} targetDir @param {RuntimeOptions} options @param {InstallContext} context @param {number} index @param {number} total @param {ProgressRange} range @returns {Promise<void>} */
async function installOcrPackageBatch(
  pythonPath,
  packages,
  targetDir,
  options,
  context,
  index,
  total,
  range,
) {
  const batchLabel = resolveOcrInstallBatchLabel(packages, options);
  const stepLabel = [`패키지 설치 ${index + 1}/${total}`, batchLabel]
    .filter(Boolean)
    .join(": ");
  context.monitor.setStep(stepLabel, range.start, range.end);
  await runShellCommand(
    buildOcrPipInstallCommand(
      pythonPath,
      packages,
      targetDir,
      options,
      context.pipProgressArgs,
    ),
    {
      timeoutMs: resolvePipInstallTimeout(options),
      env: context.pipInstallEnv,
      signal: options.abortSignal,
      onOutput: (line) => context.monitor.log(line),
    },
  );
  context.monitor.completeStep(`패키지 설치 ${index + 1}/${total} 완료`);
}

/** @param {RuntimeOptions} options @returns {number} */
function resolvePipInstallTimeout(options) {
  return (
    readPositiveInteger(
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_PIP_TIMEOUT_MS", options),
    ) || 1800000
  );
}

/** @param {string} pythonPath @param {string} [pipProgressArgs] @returns {string} */
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

/** @param {string} pythonPath @returns {string} */
function buildOcrPythonBuildToolCheckCommand(pythonPath) {
  return `${quoteCommandArg(pythonPath)} -c ${quoteCommandArg("import pip, setuptools, wheel; import setuptools.build_meta; print('python build tooling ok')")}`;
}

/** @param {string} pythonPath @param {string[]} packages @param {string | null} targetDir @param {RuntimeOptions} [options] @param {string} [pipProgressArgs] @returns {string} */
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

/** @param {string[]} packages @param {RuntimeOptions} [options] @returns {string[]} */
function resolveOcrPipInstallExtraArgs(packages, options = {}) {
  const texts = Array.isArray(packages)
    ? packages.map((item) => String(item || "").toLowerCase())
    : [];
  const containsSourceArchive = texts.some((text) =>
    /\.(?:tar\.gz|zip)(?:[?#].*)?$/.test(text),
  );
  const containsRocmSdist = texts.some(isAmdRocmMetaPackageText);
  const containsRocmTorchWheel = texts.some(isAmdRocmTorchWheelText);
  const isRocm = resolveOcrGpuBackend(options) === "rocm-transformers";
  const args = [];
  if (containsRocmSdist || (isRocm && containsSourceArchive)) {
    args.push("--no-build-isolation");
  }
  if (isRocm && (containsRocmSdist || containsRocmTorchWheel)) {
    args.push("--no-deps");
  }
  return args;
}

/** @param {unknown} text @returns {boolean} */
function isAmdRocmMetaPackageText(text) {
  return /(?:^|[/\\])rocm-\d+(?:\.\d+)*\.tar\.gz(?:[?#].*)?$/i.test(
    String(text ?? ""),
  );
}

/** @param {unknown} text @returns {boolean} */
function isAmdRocmTorchWheelText(text) {
  return /(?:^|[/\\])(?:torch|torchaudio|torchvision)-[^/\\]*rocm[^/\\]*\.whl(?:[?#].*)?$/i.test(
    String(text ?? ""),
  );
}

/** @param {string[][]} installBatches @param {number} startPercent @param {number} endPercent @returns {ProgressRange[]} */
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
  const weights = batches.map((packages, index) =>
    resolveInstallBatchWeight(packages, batches.length, index),
  );
  return allocateProgressRanges(weights, start, end);
}

/** @param {string[]} packages @param {number} batchCount @param {number} index @returns {number} */
function resolveInstallBatchWeight(packages, batchCount, index) {
  const packageText = Array.isArray(packages)
    ? packages.join(" ").toLowerCase()
    : "";
  if (packageText.includes("safetensors")) {
    return batchCount > 1 ? 0.04 : 1;
  }
  if (packageText.includes("paddlepaddle")) {
    return batchCount > 1 ? 0.36 : 1;
  }
  if (packageText.includes("rocm_sdk") || packageText.includes("torch-")) {
    return batchCount > 1 ? 0.36 : 1;
  }
  if (packageText.includes("paddleocr") || packageText.includes("paddlex")) {
    return batchCount > 1 ? 0.64 : 1;
  }
  return 1 + index * 0;
}

/** @param {number[]} weights @param {number} start @param {number} end @returns {ProgressRange[]} */
function allocateProgressRanges(weights, start, end) {
  const totalWeight =
    weights.reduce((sum, value) => sum + Math.max(0.01, value), 0) || 1;
  let cursor = start;
  return weights.map((weight, index) => {
    const isLast = index === weights.length - 1;
    const next = isLast
      ? end
      : cursor + (end - start) * (Math.max(0.01, weight) / totalWeight);
    const range = { start: cursor, end: next };
    cursor = next;
    return range;
  });
}

module.exports = {
  buildOcrPipBuildToolUpgradeCommand,
  buildOcrPipInstallCommand,
  buildOcrPythonBuildToolCheckCommand,
  installOcrPythonPackages,
  resolveOcrInstallBatchProgressRanges,
  resolveOcrPipInstallExtraArgs,
};
