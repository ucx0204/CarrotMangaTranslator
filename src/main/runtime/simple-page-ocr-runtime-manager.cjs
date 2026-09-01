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
  canImportOcrRuntime: verification.canImportOcrRuntime,
  createOcrRuntimeError: verification.createOcrRuntimeError,
  ensureOcrRuntime: orchestrator.ensureOcrRuntime,
  resolveOcrInstallBatchProgressRanges:
    installer.resolveOcrInstallBatchProgressRanges,
  resolveIntegrityPinnedOcrInstallBatches:
    installer.resolveIntegrityPinnedOcrInstallBatches,
  resolveOcrPipInstallExtraArgs: installer.resolveOcrPipInstallExtraArgs,
};
