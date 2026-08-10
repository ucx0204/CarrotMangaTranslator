// @ts-check
// Compatibility facade. Runtime policy flows from values/device to layout,
// install planning, diagnostics, and finally child-process environment.

const environment = require("./ocr/runtime-environment.cjs");
const errors = require("./ocr/runtime-errors.cjs");
const installPlan = require("./ocr/install-plan.cjs");
const layout = require("./ocr/runtime-layout.cjs");
const device = require("./ocr/runtime-device.cjs");

module.exports = {
  OCR_ROCM_LONGEST_FINAL_ENTRY: layout.OCR_ROCM_LONGEST_FINAL_ENTRY,
  OCR_ROCM_LONGEST_LIBRARY_ENTRY: layout.OCR_ROCM_LONGEST_LIBRARY_ENTRY,
  OCR_ROCM_LONGEST_PIP_TEMP_ENTRY: layout.OCR_ROCM_LONGEST_PIP_TEMP_ENTRY,
  OCR_ROCM_WINDOWS_VERSION: layout.OCR_ROCM_WINDOWS_VERSION,
  WINDOWS_LEGACY_MAX_PATH: layout.WINDOWS_LEGACY_MAX_PATH,
  WINDOWS_PATH_SAFETY_MARGIN: layout.WINDOWS_PATH_SAFETY_MARGIN,
  buildOcrRuntimeEnv: environment.buildOcrRuntimeEnv,
  buildPaddleOcrCpuThreadEnv: environment.buildPaddleOcrCpuThreadEnv,
  buildPaddleOcrGpuFailureMessage: errors.buildPaddleOcrGpuFailureMessage,
  buildPaddleOcrImportCheckScript: errors.buildPaddleOcrImportCheckScript,
  buildPaddleOcrImportFailureMessage: errors.buildPaddleOcrImportFailureMessage,
  hasNonAsciiPath: layout.hasNonAsciiPath,
  isGpuDeviceLostOrTdrText: errors.isGpuDeviceLostOrTdrText,
  isGpuOutOfMemoryText: errors.isGpuOutOfMemoryText,
  isOcrBackendPackageIdentityFailureText:
    errors.isOcrBackendPackageIdentityFailureText,
  isOcrCudaTransformersRuntime: device.isOcrCudaTransformersRuntime,
  isOcrGpuRequested: device.isOcrGpuRequested,
  isOcrTransformersEngine: device.isOcrTransformersEngine,
  isOcrTransformersRuntime: device.isOcrTransformersRuntime,
  isPaddleNativeDllLoadFailureText: errors.isPaddleNativeDllLoadFailureText,
  isPaddleSm120UnsupportedText: errors.isPaddleSm120UnsupportedText,
  isRocmHipAccessViolationText: errors.isRocmHipAccessViolationText,
  isWindowsRocmOcrRuntimePathShortEnough:
    layout.isWindowsRocmOcrRuntimePathShortEnough,
  resolveBootstrapPython: layout.resolveBootstrapPython,
  resolveEffectiveOcrDevice: device.resolveEffectiveOcrDevice,
  resolveInstallProgressDir: layout.resolveInstallProgressDir,
  resolveOcrDevice: device.resolveOcrDevice,
  resolveOcrDeviceLabel: device.resolveOcrDeviceLabel,
  resolveOcrGpuBackend: device.resolveOcrGpuBackend,
  resolveOcrGpuCudaTag: device.resolveOcrGpuCudaTag,
  resolveOcrGpuPackageIndexUrl: device.resolveOcrGpuPackageIndexUrl,
  resolveOcrInstallSignature: installPlan.resolveOcrInstallSignature,
  resolveOcrInstallBatchLabel: installPlan.resolveOcrInstallBatchLabel,
  resolveOcrPipInstallBatches: installPlan.resolveOcrPipInstallBatches,
  resolveOcrPipCacheDir: layout.resolveOcrPipCacheDir,
  resolveOcrPythonPackageDir: layout.resolveOcrPythonPackageDir,
  resolveOcrPythonUserBaseDir: layout.resolveOcrPythonUserBaseDir,
  resolveOcrRuntimeDir: layout.resolveOcrRuntimeDir,
  resolveOcrRuntimeVariant: device.resolveOcrRuntimeVariant,
  resolveOcrTorchCudaTag: device.resolveOcrTorchCudaTag,
  resolveOcrTorchPackageIndexUrl: device.resolveOcrTorchPackageIndexUrl,
  resolveOcrTempDir: layout.resolveOcrTempDir,
  resolveOcrVenvDir: layout.resolveOcrVenvDir,
  resolvePaddlexCacheAliasRoot: layout.resolvePaddlexCacheAliasRoot,
  resolvePaddlexCacheHome: layout.resolvePaddlexCacheHome,
  resolvePaddleOcrWorkerThreadCount:
    environment.resolvePaddleOcrWorkerThreadCount,
  resolvePaddleOcrImportCheckTimeoutMs:
    device.resolvePaddleOcrImportCheckTimeoutMs,
  resolveRealPaddlexCacheHome: layout.resolveRealPaddlexCacheHome,
  resolveVenvPythonPath: layout.resolveVenvPythonPath,
  shouldAllowSystemPythonFallback: layout.shouldAllowSystemPythonFallback,
  shouldUseWindowsShortRocmOcrLayout: layout.shouldUseWindowsShortRocmOcrLayout,
  summarizeOcrInstallBatches: installPlan.summarizeOcrInstallBatches,
  summarizeOcrErrorMessage: errors.summarizeOcrErrorMessage,
};
