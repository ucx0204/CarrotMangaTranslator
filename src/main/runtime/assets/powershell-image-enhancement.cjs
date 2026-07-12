// @ts-check
const { spawn } = require("node:child_process");
const path = require("node:path");
const { buildUtilityChildEnv } = require("../simple-page-child-env.cjs");
const { resolveWorkingDir } = require("../simple-page-cache-paths.cjs");
const { shrinkBuffer } = require("../simple-page-shell-utils.cjs");
const {
  createDetailedError,
  truncateText,
} = require("../simple-page-runtime-common.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { enhancedContrast?: unknown; enhancedMaxLongSide?: unknown; imagePath: string; outputDir: string }} ImageVariantOptions */

/** @param {ImageVariantOptions} options */
async function buildEnhancedVariantWithPowerShell(options) {
  const outputPath = path.join(options.outputDir, "input-enhanced.png");
  const scriptPath = path.join(__dirname, "..", "build-page-variant.ps1");
  await runEnhancementScript(options, scriptPath, outputPath);
  return outputPath;
}

/** @param {ImageVariantOptions} options @param {string} scriptPath @param {string} outputPath @returns {Promise<void>} */
function runEnhancementScript(options, scriptPath, outputPath) {
  return new Promise((resolve, reject) => {
    const state = { stdout: "", stderr: "" };
    const child = spawn(
      "powershell",
      buildScriptArgs(options, scriptPath, outputPath),
      {
        cwd: resolveWorkingDir(options),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: buildUtilityChildEnv(options),
      },
    );
    bindScriptOutput(child, state);
    child.on("error", (error) =>
      reject(
        buildScriptStartError(options, scriptPath, outputPath, state, error),
      ),
    );
    child.on("exit", (code) =>
      finishScript(
        options,
        scriptPath,
        outputPath,
        state,
        code,
        resolve,
        reject,
      ),
    );
  });
}

/** @param {ImageVariantOptions} options @param {string} scriptPath @param {string} outputPath */
function buildScriptArgs(options, scriptPath, outputPath) {
  return [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-Path",
    options.imagePath,
    "-OutputPath",
    outputPath,
    "-MaxLongSide",
    String(options.enhancedMaxLongSide),
    "-Contrast",
    String(options.enhancedContrast),
    "-Grayscale",
  ];
}

/** @param {import("node:child_process").ChildProcess} child @param {{ stdout: string; stderr: string }} state */
function bindScriptOutput(child, state) {
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    state.stdout = shrinkBuffer(state.stdout, chunk, 4000);
  });
  child.stderr?.on("data", (chunk) => {
    state.stderr = shrinkBuffer(state.stderr, chunk, 4000);
  });
}

/** @param {ImageVariantOptions} options @param {string} scriptPath @param {string} outputPath @param {{ stdout: string; stderr: string }} state @param {unknown} cause */
function buildScriptStartError(options, scriptPath, outputPath, state, cause) {
  return createDetailedError(
    "Failed to launch build-page-variant.ps1.",
    scriptErrorDetail(options, scriptPath, outputPath, state),
    cause,
  );
}

/** @param {ImageVariantOptions} options @param {string} scriptPath @param {string} outputPath @param {{ stdout: string; stderr: string }} state @param {number | null} code @param {() => void} resolve @param {(error: unknown) => void} reject */
function finishScript(
  options,
  scriptPath,
  outputPath,
  state,
  code,
  resolve,
  reject,
) {
  if (code === 0) {
    resolve();
    return;
  }
  reject(
    createDetailedError(
      `build-page-variant.ps1 failed (${code ?? "null"}).`,
      scriptErrorDetail(options, scriptPath, outputPath, state),
    ),
  );
}

/** @param {ImageVariantOptions} options @param {string} scriptPath @param {string} outputPath @param {{ stdout: string; stderr: string }} state */
function scriptErrorDetail(options, scriptPath, outputPath, state) {
  return {
    scriptPath,
    imagePath: options.imagePath,
    outputPath,
    stdout: truncateText(state.stdout.trim(), 4000),
    stderr: truncateText(state.stderr.trim(), 4000),
    parameters: {
      maxLongSide: options.enhancedMaxLongSide,
      contrast: options.enhancedContrast,
      grayscale: true,
    },
  };
}

module.exports = { buildEnhancedVariantWithPowerShell };
