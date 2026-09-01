// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */

const { truncateText } = require("./config-values.cjs");
const {
  isOcrCudaTorchRuntime,
  isOcrGpuRequested,
  isOcrTorchRuntime,
  resolveOcrGpuBackend,
  resolveOcrGpuCudaTag,
  resolveOcrTorchCudaTag,
} = require("./runtime-device.cjs");
const {
  isHayaiOcrPipeline,
  resolveOcrEngineLabel,
} = require("./engine-profile.cjs");
const {
  buildOcrRuntimeImportCheckScript,
} = require("./runtime-import-check-script.cjs");

/** @param {unknown} importMessage @param {RuntimeOptions} [options] @returns {string} */
function buildOcrRuntimeImportFailureMessage(importMessage, options = {}) {
  const preflightFailure = resolveImportPreflightFailure(
    importMessage,
    options,
  );
  if (preflightFailure) {
    return preflightFailure;
  }
  if (
    isOcrTorchRuntime(options) &&
    isOcrNativeDllLoadFailureText(importMessage)
  ) {
    return buildOcrNativeDllFailureMessage(importMessage, options);
  }
  if (isRocmGpu(options)) {
    return buildRocmImportFailureMessage(importMessage, options);
  }
  if (isOcrCudaTorchRuntime(options)) {
    return buildCudaTransformersImportFailureMessage(importMessage, options);
  }
  if (
    !isHayaiOcrPipeline(options) &&
    isPaddleSm120UnsupportedText(importMessage)
  ) {
    return buildPaddleOcrSm120FailureMessage(importMessage, options);
  }
  if (isOcrNativeDllLoadFailureText(importMessage)) {
    return buildOcrNativeDllFailureMessage(importMessage, options);
  }
  if (isOcrVerificationTimeoutText(importMessage)) {
    return `${resolveOcrEngineLabel(options)} 런타임 설치 후 검증이 시간 초과되었습니다.${resolveOcrTimeoutSuffix(options)} detail=${truncateText(importMessage, 1200)}`;
  }
  return buildGenericImportFailureMessage(importMessage, options);
}

/** @param {unknown} importMessage @param {RuntimeOptions} options @returns {string | null} */
function resolveImportPreflightFailure(importMessage, options) {
  if (isOcrBackendPackageIdentityFailureText(importMessage)) {
    return buildOcrBackendPackageIdentityFailureMessage(importMessage, options);
  }
  if (
    isHayaiOcrPipeline(options) &&
    isOcrVerificationTimeoutText(importMessage)
  ) {
    return `HayaiOCR 런타임 설치 후 검증이 시간 초과되었습니다.${resolveOcrTimeoutSuffix(options)} detail=${truncateText(importMessage, 1200)}`;
  }
  return null;
}

/** @param {unknown} importMessage @param {RuntimeOptions} options @returns {string} */
function buildOcrBackendPackageIdentityFailureMessage(importMessage, options) {
  const expected = !isOcrGpuRequested(options)
    ? isHayaiOcrPipeline(options)
      ? "CPU PyTorch 2.9.1"
      : "CPU PaddlePaddle"
    : isRocmGpu(options)
      ? "PyTorch 2.9.1+rocm7.2.1"
      : isOcrCudaTorchRuntime(options)
        ? `PyTorch 2.9.1+${resolveOcrTorchCudaTag(options)}`
        : `CUDA ${resolveOcrGpuCudaTag(options)} PaddlePaddle GPU`;
  return `OCR 장치와 다른 백엔드 패키지가 설치되어 실행을 중단했습니다. 필요 패키지: ${expected}. 잘못된 런타임은 재사용하지 않고 자동 재설치 대상으로 처리합니다. detail=${truncateText(importMessage, 1200)}`;
}

/** @param {unknown} importMessage @param {RuntimeOptions} options @returns {string} */
function buildCudaTransformersImportFailureMessage(importMessage, options) {
  const detail = importMessage
    ? ` detail=${truncateText(importMessage, 1200)}`
    : "";
  const engine = resolveOcrEngineLabel(options);
  if (isOcrVerificationTimeoutText(importMessage)) {
    return `${engine} 런타임 설치 후 NVIDIA CUDA/PyTorch 검증이 시간 초과되었습니다. 첫 PyTorch CUDA import는 오래 걸릴 수 있습니다.${detail}`;
  }
  return isHayaiOcrPipeline(options)
    ? `HayaiOCR NVIDIA GPU 실행에 실패했습니다. PyTorch CUDA 런타임, NVIDIA 드라이버와 ${resolveOcrTorchCudaTag(options)} 설정을 확인하세요.${detail}`
    : `NVIDIA OCR GPU 실행에 실패했습니다. 이 OCR 경로는 PyTorch CUDA + PaddleOCR Transformers engine을 사용합니다. NVIDIA 드라이버와 ${resolveOcrGpuCudaTag(options)} GPU 설정을 확인하세요.${detail}`;
}

/** @param {RuntimeOptions} options @returns {boolean} */
function isRocmGpu(options) {
  return (
    isOcrGpuRequested(options) &&
    resolveOcrGpuBackend(options) === "rocm-transformers"
  );
}

/** @param {unknown} importMessage @param {RuntimeOptions} options @returns {string} */
function buildRocmImportFailureMessage(importMessage, options) {
  const detail = importMessage
    ? ` detail=${truncateText(importMessage, 1200)}`
    : "";
  const engine = resolveOcrEngineLabel(options);
  if (isOcrVerificationTimeoutText(importMessage)) {
    return `${engine} 런타임 설치 후 AMD ROCm/PyTorch 검증이 시간 초과되었습니다. Windows ROCm PyTorch 첫 import가 오래 걸릴 수 있습니다.${detail}`;
  }
  return isHayaiOcrPipeline(options)
    ? `HayaiOCR AMD GPU 실행에 실패했습니다. Windows ROCm PyTorch 2.9.1/ROCm 7.2.1이 지원하는 GPU와 드라이버가 필요합니다. CPU로 처리하려면 설정에서 OCR 장치를 CPU로 직접 변경하세요.${detail}`
    : `AMD OCR GPU 실행에 실패했습니다. AMD 경로는 PaddlePaddle CUDA가 아니라 Windows ROCm PyTorch + PaddleOCR Transformers engine을 사용합니다. Windows ROCm PyTorch 2.9.1/ROCm 7.2.1이 지원하는 GPU와 드라이버가 필요합니다. 실패가 반복되면 AMD ROCm OCR 안전 모드(dtype=float32, MIOpen 비활성화, det limit=1600)가 적용됐는지 확인하세요. CPU로 처리하려면 설정에서 OCR 장치를 CPU로 직접 변경하세요.${detail}`;
}

/** @param {unknown} importMessage @param {RuntimeOptions} options @returns {string} */
function buildGenericImportFailureMessage(importMessage, options) {
  if (isHayaiOcrPipeline(options)) {
    const deviceLabel = isOcrGpuRequested(options) ? "GPU" : "CPU";
    const detail = importMessage
      ? ` detail=${truncateText(importMessage, 1200)}`
      : "";
    return `HayaiOCR ${deviceLabel} 런타임을 불러오지 못했습니다. 선택한 장치와 PyTorch 런타임 설치 상태를 확인하세요.${detail}`;
  }
  const suffix = isOcrGpuRequested(options)
    ? " GPU를 선택했지만 GPU Paddle/CUDA 검증에 실패했습니다. CPU로 처리하려면 설정에서 OCR 장치를 CPU로 직접 바꾸거나, GPU를 계속 쓰려면 CUDA 드라이버와 GPU Paddle wheel을 확인하세요."
    : "";
  const detail = importMessage
    ? ` detail=${truncateText(importMessage, 1200)}`
    : "";
  return `Paddle OCR runtime was installed but paddleocr/paddlex/paddle imports still fail.${suffix}${detail}`;
}

/** @param {RuntimeOptions} options @returns {string} */
function resolveOcrTimeoutSuffix(options) {
  if (!isOcrGpuRequested(options)) {
    return " CPU 런타임 검증이 제한 시간 안에 끝나지 않았습니다.";
  }
  if (resolveOcrGpuBackend(options) === "rocm-transformers") {
    return " AMD ROCm/PyTorch GPU 검증이 제한 시간 안에 끝나지 않았습니다. Windows ROCm PyTorch 2.9.1/ROCm 7.2.1 지원 GPU와 드라이버를 확인하세요.";
  }
  if (isOcrCudaTorchRuntime(options)) {
    return " NVIDIA CUDA/PyTorch GPU 검증이 제한 시간 안에 끝나지 않았습니다. 첫 PyTorch CUDA import가 오래 걸릴 수 있지만, 반복되면 NVIDIA 드라이버와 OCR 런타임 설치 상태를 확인하세요.";
  }
  return " CUDA GPU 검증이 제한 시간 안에 끝나지 않았습니다. RTX 50번대는 cu129 런타임을 사용하며 첫 실행 검증이 오래 걸릴 수 있지만, 반복되면 NVIDIA 드라이버/CUDA 12.9용 Paddle 런타임 호환성을 확인해야 합니다.";
}

/** @param {unknown} error @param {RuntimeOptions} [options] @returns {string} */
function buildOcrGpuFailureMessage(error, options = {}) {
  const text = summarizeOcrErrorMessage(error);
  if (isOcrBackendPackageIdentityFailureText(text)) {
    return buildOcrBackendPackageIdentityFailureMessage(text, options);
  }
  if (isGpuOutOfMemoryText(text)) {
    return `GPU 메모리(VRAM) 부족으로 OCR이 실패했습니다. 큰 페이지가 이어지거나 인페인팅 등 다른 GPU 작업과 겹치면 발생할 수 있습니다. GPU를 쓰는 다른 앱을 닫거나 설정에서 OCR 장치를 CPU로 직접 바꾸면 안정적입니다. detail=${truncateText(text, 1200)}`;
  }
  if (isGpuDeviceLostOrTdrText(text)) {
    return `GPU 드라이버가 재설정되어 OCR이 중단됐습니다. 디스플레이 겸용 GPU에서 오래 걸리는 연산은 Windows TDR(기본 2초)로 끊길 수 있습니다. AMD/NVIDIA 드라이버를 최신으로 유지하고, 반복되면 README의 TdrDelay 안내를 참고하거나 설정에서 OCR 장치를 CPU로 직접 바꾸세요. detail=${truncateText(text, 1200)}`;
  }
  if (isOcrTorchRuntime(options) && isOcrNativeDllLoadFailureText(text)) {
    return buildOcrNativeDllFailureMessage(text, options);
  }
  if (resolveOcrGpuBackend(options) === "rocm-transformers") {
    return buildRocmGpuFailureMessage(text, options);
  }
  if (isOcrCudaTorchRuntime(options)) {
    return isHayaiOcrPipeline(options)
      ? `HayaiOCR NVIDIA GPU 실행에 실패했습니다. PyTorch CUDA 런타임과 NVIDIA 드라이버를 확인하세요. detail=${truncateText(text, 1200)}`
      : `NVIDIA OCR GPU 실행에 실패했습니다. PyTorch CUDA + PaddleOCR Transformers 런타임과 NVIDIA 드라이버를 확인하세요. detail=${truncateText(text, 1200)}`;
  }
  if (!isHayaiOcrPipeline(options) && isPaddleSm120UnsupportedText(text)) {
    return buildPaddleOcrSm120FailureMessage(text, options);
  }
  return `Paddle OCR GPU 실행에 실패했습니다. GPU 설정을 쓰려면 CUDA가 보이는 NVIDIA GPU Paddle 런타임이 필요합니다. CPU로 처리하려면 설정에서 OCR 장치를 CPU로 직접 바꾸거나, GPU를 계속 쓰려면 NVIDIA 드라이버/CUDA용 Paddle 런타임을 확인하세요. detail=${truncateText(text, 1200)}`;
}

/** @param {string} text @param {RuntimeOptions} options @returns {string} */
function buildRocmGpuFailureMessage(text, options) {
  if (isRocmHipAccessViolationText(text)) {
    return `Windows ROCm HIP 런타임의 알려진 간헐 크래시로 보입니다(amdhip64 access violation). AMD Adrenalin 드라이버를 최신으로 유지하고, 내장 GPU(iGPU)가 함께 있는 시스템이라면 BIOS에서 iGPU를 비활성화하면 도움이 될 수 있습니다. detail=${truncateText(text, 1200)}`;
  }
  const engine = resolveOcrEngineLabel(options);
  return `${engine} AMD GPU 실행에 실패했습니다. Windows ROCm PyTorch 2.9.1/ROCm 7.2.1이 지원하는 GPU와 Python 3.12가 필요합니다. AMD ROCm 지원 GPU/드라이버를 확인하세요. CPU로 처리하려면 설정에서 OCR 장치를 CPU로 직접 변경하세요. detail=${truncateText(text, 1200)}`;
}

/** @param {unknown} detail @param {RuntimeOptions} [options] @returns {string} */
function buildPaddleOcrSm120FailureMessage(detail, options = {}) {
  return `RTX 50번대/SM120에서 현재 Paddle OCR GPU 런타임이 맞지 않습니다. RTX 50번대는 CUDA 12.9용 Paddle OCR 런타임(cu129)을 사용해야 합니다. 설정값은 현재 ${resolveOcrGpuCudaTag(options)}입니다. 기존 gpu-cu126 런타임이 남아 있으면 OCR 런타임을 삭제하고 다시 시도하세요. detail=${truncateText(detail, 1200)}`;
}

/** @param {unknown} detail @param {RuntimeOptions} [options] @returns {string} */
function buildOcrNativeDllFailureMessage(detail, options = {}) {
  const engine = resolveOcrEngineLabel(options);
  if (isRocmGpu(options)) {
    return `${engine} AMD GPU 런타임의 Windows ROCm PyTorch DLL을 불러오지 못했습니다. 자동 복구 후에도 반복되면 Microsoft Visual C++ 2015-2022 재배포 패키지, Windows ROCm PyTorch 2.9.1/ROCm 7.2.1 지원 GPU/드라이버와 OCR 런타임 설치 상태를 확인하세요. detail=${truncateText(detail, 1200)}`;
  }
  if (isOcrCudaTorchRuntime(options)) {
    return `${engine} NVIDIA GPU 런타임의 PyTorch CUDA DLL을 불러오지 못했습니다. 자동 복구 후에도 반복되면 Microsoft Visual C++ 2015-2022 재배포 패키지, NVIDIA 드라이버와 CUDA Transformers OCR 런타임 설치 상태를 확인하세요. detail=${truncateText(detail, 1200)}`;
  }
  const runtimeLabel = isOcrGpuRequested(options) ? "GPU" : "CPU";
  if (isHayaiOcrPipeline(options)) {
    return `HayaiOCR ${runtimeLabel} 런타임의 PyTorch 네이티브 DLL을 불러오지 못했습니다. 자동 복구 후에도 반복되면 Microsoft Visual C++ 2015-2022 재배포 패키지와 OCR 런타임 설치 상태를 확인하세요. detail=${truncateText(detail, 1200)}`;
  }
  return `Paddle OCR ${runtimeLabel} 런타임의 네이티브 DLL을 불러오지 못했습니다. 앱이 Paddle 패키지 내부 DLL 경로를 다시 잡도록 수정했지만, 같은 오류가 반복되면 OCR 런타임을 삭제하고 재설치하거나 Microsoft Visual C++ 2015-2022 재배포 패키지가 설치되어 있는지 확인하세요. detail=${truncateText(detail, 1200)}`;
}

/** @param {unknown} value @returns {boolean} */
function isPaddleSm120UnsupportedText(value) {
  return /not compiled for\s+SM\s*120|sm[_\s-]*120|compute capability:\s*12(?:\.0)?|mismatched gpu architecture/i.test(
    String(value ?? ""),
  );
}

/** @param {unknown} value @returns {boolean} */
function isOcrNativeDllLoadFailureText(value) {
  const text = String(value ?? "");
  if (
    /can not import paddle core|libpaddle\.pyd|dll load failed while importing libpaddle|the specified module could not be found/i.test(
      text,
    )
  ) {
    return true;
  }
  if (/dll load failed while importing _c\b/i.test(text)) {
    return true;
  }
  const referencesTorchDll =
    /torch[\\/]+lib[\\/]+[^\s"']+\.dll\b|\b(?:c10|torch_(?:cpu|cuda|python)|fbgemm|shm)\.dll\b/i.test(
      text,
    );
  const reportsNativeLoaderFailure =
    /winerror\s*126|dll load failed|error loading|could not find module|specified procedure could not be found|dependent librar(?:y|ies)/i.test(
      text,
    );
  return referencesTorchDll && reportsNativeLoaderFailure;
}

/** @param {unknown} value @returns {boolean} */
function isOcrBackendPackageIdentityFailureText(value) {
  return /Unexpected (?:NVIDIA CUDA|AMD ROCm|CPU) (?:PyTorch|TorchVision|PaddlePaddle) build|PyTorch is not a (?:CUDA|ROCm\/HIP) build|PaddlePaddle is not compiled with CUDA/i.test(
    String(value ?? ""),
  );
}

/** @param {unknown} value @returns {boolean} */
function isGpuOutOfMemoryText(value) {
  return /out of memory|hipErrorOutOfMemory|OutOfMemoryError|CUDA error: out of memory|ResourceExhausted/i.test(
    String(value ?? ""),
  );
}

/** @param {unknown} value @returns {boolean} */
function isGpuDeviceLostOrTdrText(value) {
  return /device lost|hipErrorDeviceLost|device removed|gpu hang|driver timed out|\btdr\b|hipErrorLaunchTimeOut|launch timed out/i.test(
    String(value ?? ""),
  );
}

/** @param {unknown} value @returns {boolean} */
function isRocmHipAccessViolationText(value) {
  return /access violation|amdhip64|0xc0000005|-1073741819|3221225477|windows fatal exception/i.test(
    String(value ?? ""),
  );
}

/** @param {unknown} value @returns {boolean} */
function isOcrVerificationTimeoutText(value) {
  return /(?:Paddle OCR|HayaiOCR) runtime verification timed out|OCR bbox command timed out/i.test(
    String(value ?? ""),
  );
}

/** @param {unknown} error @returns {string} */
function summarizeOcrErrorMessage(error) {
  if (!error || typeof error !== "object") {
    return String(error ?? "");
  }
  const summary =
    /** @type {{ message?: unknown; stderrPreview?: unknown; stdoutPreview?: unknown; cause?: unknown }} */ (
      error
    );
  const parts = [
    summary.message,
    summary.stderrPreview,
    summary.stdoutPreview,
    summary.cause instanceof Error ? summary.cause.message : summary.cause,
  ].filter(Boolean);
  return parts.length > 0
    ? parts.map((part) => String(part)).join(" ")
    : String(error);
}

module.exports = {
  buildOcrGpuFailureMessage,
  buildOcrRuntimeImportCheckScript,
  buildOcrRuntimeImportFailureMessage,
  isGpuDeviceLostOrTdrText,
  isGpuOutOfMemoryText,
  isOcrBackendPackageIdentityFailureText,
  isOcrNativeDllLoadFailureText,
  isPaddleSm120UnsupportedText,
  isRocmHipAccessViolationText,
  summarizeOcrErrorMessage,
};
