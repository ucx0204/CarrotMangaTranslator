// @ts-check
// Compatibility facade for the OCR runtime lifecycle.

const installer = require("./ocr/runtime-installer.cjs");
const orchestrator = require("./ocr/runtime-orchestrator.cjs");
const verification = require("./ocr/runtime-verification.cjs");

module.exports = {
  buildOcrPipBuildToolUpgradeCommand:
    installer.buildOcrPipBuildToolUpgradeCommand,
  buildOcrPipInstallCommand: installer.buildOcrPipInstallCommand,
  buildOcrPythonBuildToolCheckCommand:
    installer.buildOcrPythonBuildToolCheckCommand,
  canImportPaddleOcr: verification.canImportPaddleOcr,
  createOcrRuntimeError: verification.createOcrRuntimeError,
  ensurePaddleOcrRuntime: orchestrator.ensurePaddleOcrRuntime,
  resolveOcrInstallBatchProgressRanges:
    installer.resolveOcrInstallBatchProgressRanges,
  resolveOcrPipInstallExtraArgs: installer.resolveOcrPipInstallExtraArgs,
};
