// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */

const { truncateText } = require("./config-values.cjs");
const {
  isOcrCudaTransformersRuntime,
  isOcrGpuRequested,
  isOcrTransformersRuntime,
  resolveOcrDevice,
  resolveOcrGpuBackend,
  resolveOcrGpuCudaTag,
} = require("./runtime-device.cjs");

/** @param {unknown} importMessage @param {RuntimeOptions} [options] @returns {string} */
function buildPaddleOcrImportFailureMessage(importMessage, options = {}) {
  if (
    isOcrTransformersRuntime(options) &&
    isPaddleNativeDllLoadFailureText(importMessage)
  ) {
    return buildPaddleOcrNativeDllFailureMessage(importMessage, options);
  }
  if (isRocmGpu(options)) {
    return buildRocmImportFailureMessage(importMessage);
  }
  if (isOcrCudaTransformersRuntime(options)) {
    return buildCudaTransformersImportFailureMessage(importMessage, options);
  }
  if (isPaddleSm120UnsupportedText(importMessage)) {
    return buildPaddleOcrSm120FailureMessage(importMessage, options);
  }
  if (isPaddleBfloat16SafetensorsText(importMessage)) {
    return buildPaddleOcrBfloat16SafetensorsFailureMessage(
      importMessage,
      options,
    );
  }
  if (isPaddleNativeDllLoadFailureText(importMessage)) {
    return buildPaddleOcrNativeDllFailureMessage(importMessage, options);
  }
  if (isPaddleOcrVerificationTimeoutText(importMessage)) {
    return `Paddle OCR 런타임 설치 후 검증이 시간 초과되었습니다.${resolvePaddleOcrTimeoutSuffix(options)} detail=${truncateText(importMessage, 1200)}`;
  }
  return buildGenericImportFailureMessage(importMessage, options);
}

/** @param {unknown} importMessage @param {RuntimeOptions} options @returns {string} */
function buildCudaTransformersImportFailureMessage(importMessage, options) {
  const detail = importMessage
    ? ` detail=${truncateText(importMessage, 1200)}`
    : "";
  if (isPaddleOcrVerificationTimeoutText(importMessage)) {
    return `Paddle OCR 런타임 설치 후 NVIDIA CUDA/PyTorch 검증이 시간 초과되었습니다. 첫 PyTorch CUDA import는 오래 걸릴 수 있습니다.${detail}`;
  }
  return `NVIDIA OCR GPU 실행에 실패했습니다. 이 OCR 경로는 PaddlePaddle CUDA가 아니라 PyTorch CUDA + PaddleOCR Transformers engine을 사용합니다. NVIDIA 드라이버와 ${resolveOcrGpuCudaTag(options)} GPU 설정을 확인하세요. 기존 PaddleOCR-VL CUDA 방식은 CUDA 레거시 풀로드에서 사용할 수 있습니다.${detail}`;
}

/** @param {RuntimeOptions} options @returns {boolean} */
function isRocmGpu(options) {
  return (
    isOcrGpuRequested(options) &&
    resolveOcrGpuBackend(options) === "rocm-transformers"
  );
}

/** @param {unknown} importMessage @returns {string} */
function buildRocmImportFailureMessage(importMessage) {
  const detail = importMessage
    ? ` detail=${truncateText(importMessage, 1200)}`
    : "";
  if (isPaddleOcrVerificationTimeoutText(importMessage)) {
    return `Paddle OCR 런타임 설치 후 AMD ROCm/PyTorch 검증이 시간 초과되었습니다. Windows ROCm PyTorch 첫 import가 오래 걸릴 수 있습니다.${detail}`;
  }
  return `AMD OCR GPU 실행에 실패했습니다. AMD 경로는 PaddlePaddle CUDA가 아니라 Windows ROCm PyTorch + PaddleOCR Transformers engine을 사용합니다. Windows ROCm PyTorch 2.9.1/ROCm 7.2.1이 지원하는 GPU와 드라이버가 필요합니다. 실패가 반복되면 AMD ROCm OCR 안전 모드(dtype=float32, MIOpen 비활성화, det limit=1600)가 적용됐는지 확인하세요. CPU로 처리하려면 설정에서 OCR 장치를 CPU로 직접 변경하세요.${detail}`;
}

/** @param {unknown} importMessage @param {RuntimeOptions} options @returns {string} */
function buildGenericImportFailureMessage(importMessage, options) {
  const suffix = isOcrGpuRequested(options)
    ? " GPU를 선택했지만 GPU Paddle/CUDA 검증에 실패했습니다. CPU로 처리하려면 설정에서 OCR 장치를 CPU로 직접 바꾸거나, GPU를 계속 쓰려면 CUDA 드라이버와 GPU Paddle wheel을 확인하세요."
    : "";
  const detail = importMessage
    ? ` detail=${truncateText(importMessage, 1200)}`
    : "";
  return `PaddleOCR-VL runtime was installed but paddleocr/paddlex/paddle imports still fail.${suffix}${detail}`;
}

/** @param {RuntimeOptions} options @returns {string} */
function resolvePaddleOcrTimeoutSuffix(options) {
  if (!isOcrGpuRequested(options)) {
    return " CPU 런타임 검증이 제한 시간 안에 끝나지 않았습니다.";
  }
  if (resolveOcrGpuBackend(options) === "rocm-transformers") {
    return " AMD ROCm/PyTorch GPU 검증이 제한 시간 안에 끝나지 않았습니다. Windows ROCm PyTorch 2.9.1/ROCm 7.2.1 지원 GPU와 드라이버를 확인하세요.";
  }
  if (isOcrCudaTransformersRuntime(options)) {
    return " NVIDIA CUDA/PyTorch GPU 검증이 제한 시간 안에 끝나지 않았습니다. 첫 PyTorch CUDA import가 오래 걸릴 수 있지만, 반복되면 NVIDIA 드라이버와 OCR 런타임 설치 상태를 확인하세요.";
  }
  return " CUDA GPU 검증이 제한 시간 안에 끝나지 않았습니다. RTX 50번대는 cu129 런타임을 사용하며 첫 실행 검증이 오래 걸릴 수 있지만, 반복되면 NVIDIA 드라이버/CUDA 12.9용 Paddle 런타임 호환성을 확인해야 합니다.";
}

/** @param {unknown} error @param {RuntimeOptions} [options] @returns {string} */
function buildPaddleOcrGpuFailureMessage(error, options = {}) {
  const text = summarizeOcrErrorMessage(error);
  if (isGpuOutOfMemoryText(text)) {
    return `GPU 메모리(VRAM) 부족으로 OCR이 실패했습니다. 큰 페이지가 이어지거나 인페인팅 등 다른 GPU 작업과 겹치면 발생할 수 있습니다. GPU를 쓰는 다른 앱을 닫거나 설정에서 OCR 장치를 CPU로 직접 바꾸면 안정적입니다. detail=${truncateText(text, 1200)}`;
  }
  if (isGpuDeviceLostOrTdrText(text)) {
    return `GPU 드라이버가 재설정되어 OCR이 중단됐습니다. 디스플레이 겸용 GPU에서 오래 걸리는 연산은 Windows TDR(기본 2초)로 끊길 수 있습니다. AMD/NVIDIA 드라이버를 최신으로 유지하고, 반복되면 README의 TdrDelay 안내를 참고하거나 설정에서 OCR 장치를 CPU로 직접 바꾸세요. detail=${truncateText(text, 1200)}`;
  }
  if (
    isOcrTransformersRuntime(options) &&
    isPaddleNativeDllLoadFailureText(text)
  ) {
    return buildPaddleOcrNativeDllFailureMessage(text, options);
  }
  if (resolveOcrGpuBackend(options) === "rocm-transformers") {
    return buildRocmGpuFailureMessage(text);
  }
  if (isOcrCudaTransformersRuntime(options)) {
    return `NVIDIA OCR GPU 실행에 실패했습니다. PyTorch CUDA + PaddleOCR Transformers 런타임과 NVIDIA 드라이버를 확인하세요. 기존 PaddleOCR-VL CUDA 방식은 CUDA 레거시 풀로드에서 사용할 수 있습니다. detail=${truncateText(text, 1200)}`;
  }
  if (isPaddleSm120UnsupportedText(text)) {
    return buildPaddleOcrSm120FailureMessage(text, options);
  }
  if (isPaddleBfloat16SafetensorsText(text)) {
    return buildPaddleOcrBfloat16SafetensorsFailureMessage(text, options);
  }
  return `Paddle OCR GPU 실행에 실패했습니다. GPU 설정을 쓰려면 CUDA가 보이는 NVIDIA GPU Paddle 런타임이 필요합니다. CPU로 처리하려면 설정에서 OCR 장치를 CPU로 직접 바꾸거나, GPU를 계속 쓰려면 NVIDIA 드라이버/CUDA용 Paddle 런타임을 확인하세요. detail=${truncateText(text, 1200)}`;
}

/** @param {string} text @returns {string} */
function buildRocmGpuFailureMessage(text) {
  if (isRocmHipAccessViolationText(text)) {
    return `Windows ROCm HIP 런타임의 알려진 간헐 크래시로 보입니다(amdhip64 access violation). AMD Adrenalin 드라이버를 최신으로 유지하고, 내장 GPU(iGPU)가 함께 있는 시스템이라면 BIOS에서 iGPU를 비활성화하면 도움이 될 수 있습니다. detail=${truncateText(text, 1200)}`;
  }
  return `AMD OCR GPU 실행에 실패했습니다. Windows ROCm PyTorch 2.9.1/ROCm 7.2.1이 지원하는 GPU와 Python 3.12가 필요합니다. AMD ROCm 지원 GPU/드라이버와 OCR 안전 모드 설정을 확인하세요. CPU로 처리하려면 설정에서 OCR 장치를 CPU로 직접 변경하세요. detail=${truncateText(text, 1200)}`;
}

/** @param {unknown} detail @param {RuntimeOptions} [options] @returns {string} */
function buildPaddleOcrSm120FailureMessage(detail, options = {}) {
  return `RTX 50번대/SM120에서 현재 Paddle OCR GPU 런타임이 맞지 않습니다. RTX 50번대는 CUDA 12.9용 Paddle OCR 런타임(cu129)을 사용해야 합니다. 설정값은 현재 ${resolveOcrGpuCudaTag(options)}입니다. 기존 gpu-cu126 런타임이 남아 있으면 OCR 런타임을 삭제하고 다시 시도하세요. detail=${truncateText(detail, 1200)}`;
}

/** @param {unknown} detail @param {RuntimeOptions} [options] @returns {string} */
function buildPaddleOcrBfloat16SafetensorsFailureMessage(detail, options = {}) {
  return `PaddleOCR-VL 모델 가중치(bfloat16)를 현재 OCR 런타임이 읽지 못했습니다. Windows에서는 PaddleOCR-VL용 special safetensors 휠과 공식 ${resolveOcrGpuCudaTag(options)} Paddle 런타임이 같이 필요합니다. OCR 런타임 패키지가 다시 설치되도록 앱을 업데이트한 뒤 재시도하세요. detail=${truncateText(detail, 1200)}`;
}

/** @param {unknown} detail @param {RuntimeOptions} [options] @returns {string} */
function buildPaddleOcrNativeDllFailureMessage(detail, options = {}) {
  if (isRocmGpu(options)) {
    return `AMD OCR GPU 런타임의 Windows ROCm PyTorch DLL을 불러오지 못했습니다. 자동 복구 후에도 반복되면 Microsoft Visual C++ 2015-2022 재배포 패키지, Windows ROCm PyTorch 2.9.1/ROCm 7.2.1 지원 GPU/드라이버와 OCR 런타임 설치 상태를 확인하세요. detail=${truncateText(detail, 1200)}`;
  }
  if (isOcrCudaTransformersRuntime(options)) {
    return `NVIDIA OCR GPU 런타임의 PyTorch CUDA DLL을 불러오지 못했습니다. 자동 복구 후에도 반복되면 Microsoft Visual C++ 2015-2022 재배포 패키지, NVIDIA 드라이버와 CUDA Transformers OCR 런타임 설치 상태를 확인하세요. detail=${truncateText(detail, 1200)}`;
  }
  const runtimeLabel = isOcrGpuRequested(options) ? "GPU" : "CPU";
  return `Paddle OCR ${runtimeLabel} 런타임의 네이티브 DLL을 불러오지 못했습니다. 앱이 Paddle 패키지 내부 DLL 경로를 다시 잡도록 수정했지만, 같은 오류가 반복되면 OCR 런타임을 삭제하고 재설치하거나 Microsoft Visual C++ 2015-2022 재배포 패키지가 설치되어 있는지 확인하세요. detail=${truncateText(detail, 1200)}`;
}

/** @param {unknown} value @returns {boolean} */
function isPaddleSm120UnsupportedText(value) {
  return /not compiled for\s+SM\s*120|sm[_\s-]*120|compute capability:\s*12(?:\.0)?|mismatched gpu architecture/i.test(
    String(value ?? ""),
  );
}

/** @param {unknown} value @returns {boolean} */
function isPaddleBfloat16SafetensorsText(value) {
  return /data type ['"]?bfloat16['"]? not understood|_load_part_state_dict_from_safetensors/i.test(
    String(value ?? ""),
  );
}

/** @param {unknown} value @returns {boolean} */
function isPaddleNativeDllLoadFailureText(value) {
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
function isPaddleOcrVerificationTimeoutText(value) {
  return /Paddle OCR runtime verification timed out|OCR bbox command timed out/i.test(
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

/** @param {RuntimeOptions} [options] @returns {string} */
function buildPaddleOcrImportCheckScript(options = {}) {
  const device = resolveOcrDevice(options);
  if (isOcrTransformersRuntime(options)) {
    return resolveOcrGpuBackend(options) === "rocm-transformers"
      ? buildRocmImportCheckScript()
      : buildCudaTransformersImportCheckScript();
  }
  return buildPaddleImportCheckScript(device);
}

/** @returns {string} */
function buildRocmImportCheckScript() {
  return [
    ...buildTransformersImportPrelude(),
    "assert not missing, 'Missing AMD ROCm OCR package(s): ' + ', '.join(missing)",
    "import torch",
    "assert torch.cuda.is_available(), 'AMD ROCm PyTorch GPU is not available'",
    "assert getattr(torch.version, 'hip', None), 'PyTorch is not a ROCm/HIP build'",
    "x = torch.ones((1,), device='cuda')",
    "torch.cuda.synchronize()",
    "import torchvision",
    "import tokenizers",
    "assert tokenizers.__version__.replace('-', '') == '0.23.0rc0', 'Unsupported tokenizers version: ' + tokenizers.__version__",
    "import transformers",
    "_auto_image_processor = transformers.AutoImageProcessor",
    "_auto_object_detector = transformers.AutoModelForObjectDetection",
    "print('torch', torch.__version__)",
    "print('hip', torch.version.hip)",
    "print('gpu', torch.cuda.get_device_name(0))",
    "from paddleocr import PaddleOCR",
  ].join("; ");
}

/** @returns {string} */
function buildCudaTransformersImportCheckScript() {
  return [
    ...buildTransformersImportPrelude(),
    "assert not missing, 'Missing NVIDIA CUDA Transformers OCR package(s): ' + ', '.join(missing)",
    "import torch",
    "assert torch.cuda.is_available(), 'NVIDIA CUDA PyTorch GPU is not available'",
    "assert getattr(torch.version, 'cuda', None), 'PyTorch is not a CUDA build'",
    "x = torch.ones((1,), device='cuda')",
    "torch.cuda.synchronize()",
    "import torchvision",
    "import tokenizers",
    "assert tokenizers.__version__.replace('-', '') == '0.23.0rc0', 'Unsupported tokenizers version: ' + tokenizers.__version__",
    "import transformers",
    "_auto_image_processor = transformers.AutoImageProcessor",
    "_auto_object_detector = transformers.AutoModelForObjectDetection",
    "print('torch', torch.__version__)",
    "print('cuda', torch.version.cuda)",
    "print('gpu', torch.cuda.get_device_name(0))",
    "from paddleocr import PaddleOCR",
  ].join("; ");
}

/** @returns {string[]} */
function buildTransformersImportPrelude() {
  return [
    "import os",
    "_dll_dirs = [p for p in os.environ.get('MANGA_TRANSLATOR_OCR_DLL_DIRS', '').split(os.pathsep) if p]",
    "_dll_handles = [os.add_dll_directory(p) for p in _dll_dirs if hasattr(os, 'add_dll_directory') and os.path.isdir(p)]",
    "import importlib.util",
    "missing = [name for name in ('torch', 'torchvision', 'transformers', 'tokenizers', 'paddlex', 'paddleocr', 'safetensors') if importlib.util.find_spec(name) is None]",
  ];
}

/** @param {string} device @returns {string} */
function buildPaddleImportCheckScript(device) {
  const lines = [
    "import os",
    "_dll_dirs = [p for p in os.environ.get('MANGA_TRANSLATOR_OCR_DLL_DIRS', '').split(os.pathsep) if p]",
    "_dll_handles = [os.add_dll_directory(p) for p in _dll_dirs if hasattr(os, 'add_dll_directory') and os.path.isdir(p)]",
    "import importlib.util",
    "missing = [name for name in ('paddle', 'paddlex', 'paddleocr') if importlib.util.find_spec(name) is None]",
    "assert not missing, 'Missing Paddle OCR package(s): ' + ', '.join(missing)",
    "import paddle",
    "from paddleocr import PaddleOCRVL, PaddleOCR",
  ];
  if (device.startsWith("gpu")) {
    lines.push(
      "assert paddle.device.is_compiled_with_cuda(), 'PaddlePaddle is not compiled with CUDA'",
      "count = paddle.device.cuda.device_count()",
      "assert count > 0, 'No CUDA device is visible to PaddlePaddle'",
      `paddle.set_device(${JSON.stringify(device)})`,
    );
  }
  return lines.join("; ");
}

module.exports = {
  buildPaddleOcrGpuFailureMessage,
  buildPaddleOcrImportCheckScript,
  buildPaddleOcrImportFailureMessage,
  isGpuDeviceLostOrTdrText,
  isGpuOutOfMemoryText,
  isPaddleBfloat16SafetensorsText,
  isPaddleNativeDllLoadFailureText,
  isPaddleSm120UnsupportedText,
  isRocmHipAccessViolationText,
  summarizeOcrErrorMessage,
};
