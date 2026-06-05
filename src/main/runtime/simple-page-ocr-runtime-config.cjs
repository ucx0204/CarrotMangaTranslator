const { existsSync } = require("node:fs");
const path = require("node:path");

const {
  DEFAULT_OCR_CPU_PIP_PACKAGES,
  DEFAULT_OCR_GPU_CUDA_TAG,
  DEFAULT_OCR_GPU_EXTRA_PACKAGES,
  DEFAULT_OCR_GPU_PADDLE_PACKAGE,
  PADDLEOCR_VL_WINDOWS_SAFETENSORS_WHEEL
} = require("./simple-page-defaults.cjs");
const {
  HF_CHILD_ENV_KEYS,
  NETWORK_CHILD_ENV_KEYS,
  buildWhitelistedChildEnv,
  isLikelyPackagedToolsDir,
  runtimeOverrideEnv,
  shouldAllowExternalRuntimeOverrides
} = require("./simple-page-child-env.cjs");
const { resolveToolsDir } = require("./simple-page-runtime-paths.cjs");

function isTruthy(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(text);
}

function readPositiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function truncateText(value, maxLength = 1200) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]`;
}

function resolveInstallProgressDir(pythonPath) {
  const resolved = path.resolve(String(pythonPath || ""));
  if (resolved.toLowerCase().endsWith(`${path.sep}scripts${path.sep}python.exe`)) {
    return path.dirname(path.dirname(resolved));
  }
  return path.dirname(resolved);
}

function resolveOcrRuntimeDir(options = {}) {
  return path.resolve(
    String(
      options.ocrRuntimeDir
        ?? runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_RUNTIME_DIR", options)
        ?? path.join(options.workingDir || process.cwd(), "ocr-runtime")
    )
  );
}

function resolveVenvPythonPath(venvDir) {
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

function resolveBootstrapPython(options = {}) {
  const explicitCandidates = [
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_PYTHON", options),
    runtimeOverrideEnv("MANGA_TRANSLATOR_PYTHON", options)
  ]
    .map((candidate) => String(candidate ?? "").trim())
    .filter(Boolean);

  for (const candidate of explicitCandidates) {
    if (candidate === "python" || existsSync(candidate)) {
      return candidate;
    }
  }

  const bundledCandidates = [
    path.join(options.toolsDir || "", "python", "python.exe"),
    path.join(options.toolsDir || "", "python", "python-embed", "python.exe"),
    path.join(options.toolsDir || "", "python.exe")
  ];

  for (const candidate of bundledCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  if (shouldAllowSystemPythonFallback(options)) {
    return "python";
  }
  return null;
}

function shouldAllowSystemPythonFallback(options = {}) {
  const explicit =
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_ALLOW_SYSTEM_PYTHON", options) ??
    runtimeOverrideEnv("MANGA_TRANSLATOR_ALLOW_SYSTEM_PYTHON", options);
  if (explicit !== undefined) {
    return isTruthy(explicit);
  }
  return !isLikelyPackagedToolsDir(options.toolsDir);
}

function resolveOcrPipInstallBatches(options = {}) {
  const explicit = splitShellLikeEnv(runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_PIP_PACKAGES", options));
  if (explicit.length > 0) {
    return withPaddleOcrVlSafetensorsBatch([explicit]);
  }

  if (!isOcrGpuRequested(options)) {
    const cpuPackages = splitShellLikeEnv(runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_CPU_PIP_PACKAGES", options));
    return withPaddleOcrVlSafetensorsBatch([cpuPackages.length > 0 ? cpuPackages : DEFAULT_OCR_CPU_PIP_PACKAGES]);
  }

  const gpuPackages = splitShellLikeEnv(runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_PIP_PACKAGES", options));
  if (gpuPackages.length > 0) {
    return withPaddleOcrVlSafetensorsBatch([gpuPackages]);
  }

  return withPaddleOcrVlSafetensorsBatch([
    resolveOcrGpuPaddleInstallBatch(options),
    DEFAULT_OCR_GPU_EXTRA_PACKAGES
  ]);
}

function resolveOcrGpuPaddleInstallBatch(options = {}) {
  const explicitWheel = String(runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_PADDLE_WHEEL", options) ?? "").trim();
  if (explicitWheel) {
    return [explicitWheel];
  }
  return [
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_PADDLE_PACKAGE", options) || DEFAULT_OCR_GPU_PADDLE_PACKAGE,
    "--index-url",
    resolveOcrGpuPackageIndexUrl(options)
  ];
}

function withPaddleOcrVlSafetensorsBatch(installBatches) {
  const batches = Array.isArray(installBatches) ? installBatches.map((batch) => Array.isArray(batch) ? [...batch] : []) : [];
  if (process.platform !== "win32") {
    return batches;
  }

  const safetensorsPackages = [];
  const normalizedBatches = batches
    .map((batch) => {
      const normalPackages = [];
      for (const item of batch) {
        const text = String(item ?? "").trim();
        if (!text) {
          continue;
        }
        if (/safetensors/i.test(text)) {
          safetensorsPackages.push(text);
          continue;
        }
        normalPackages.push(text);
      }
      return normalPackages;
    })
    .filter((batch) => batch.length > 0);

  const safetensorsBatch = [
    "--no-deps",
    "--force-reinstall",
    ...(safetensorsPackages.length > 0 ? safetensorsPackages : [PADDLEOCR_VL_WINDOWS_SAFETENSORS_WHEEL])
  ];
  return [...normalizedBatches, safetensorsBatch];
}

function splitShellLikeEnv(value) {
  const raw = String(value ?? "").trim();
  return raw ? raw.split(/\s+/).filter(Boolean) : [];
}

function summarizeOcrInstallBatches(installBatches, options = {}) {
  const packageNames = installBatches
    .flat()
    .filter((part) => !part.startsWith("-") && !/^https?:\/\//i.test(part));
  const suffix = isOcrGpuRequested(options) ? ` (${resolveOcrGpuCudaTag(options)})` : "";
  return `${packageNames.join(", ")}${suffix}`;
}

function isOcrGpuRequested(options = {}) {
  return resolveOcrDevice(options).startsWith("gpu");
}

function isOcrBlackwellCudaTag(options = {}) {
  return resolveOcrGpuCudaTag(options) === "cu129";
}

function resolveOcrGpuCudaTag(options = {}) {
  const raw = String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG", options)
      ?? runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG", options)
      ?? runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_CUDA", options)
      ?? options.ocrGpuCudaTag
      ?? DEFAULT_OCR_GPU_CUDA_TAG
  ).trim().toLowerCase();
  if (/^cu\d+$/.test(raw)) {
    return raw;
  }
  const digits = raw.replace(/\D/g, "");
  return digits ? `cu${digits}` : DEFAULT_OCR_GPU_CUDA_TAG;
}

function resolveOcrGpuPackageIndexUrl(options = {}) {
  return String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_PADDLE_INDEX_URL", options)
      ?? runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_GPU_INDEX_URL", options)
      ?? `https://www.paddlepaddle.org.cn/packages/stable/${resolveOcrGpuCudaTag(options)}/`
  ).trim();
}

function resolveOcrRuntimeVariant(options = {}) {
  if (!isOcrGpuRequested(options)) {
    return "cpu";
  }
  return `gpu-${resolveOcrGpuCudaTag(options)}`.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase();
}

function resolveOcrPythonPackageDir(runtimeDir, options = {}) {
  return path.join(runtimeDir, `python-packages-${resolveOcrRuntimeVariant(options)}`);
}

function resolveOcrDevice(options = {}) {
  const explicitDevice = String(runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_DEVICE", options) ?? "").trim();
  if (explicitDevice) {
    return explicitDevice;
  }
  const value = String(runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_DEVICE", options) ?? options.ocrDevice ?? "cpu").trim().toLowerCase();
  if (value === "gpu" || value === "cuda") {
    return "gpu:0";
  }
  if (value.startsWith("gpu")) {
    return value;
  }
  return "cpu";
}

function resolveOcrDeviceLabel(options = {}) {
  const device = resolveOcrDevice(options);
  return device === "cpu" ? "CPU" : device.toUpperCase();
}

function resolvePaddleOcrImportCheckTimeoutMs(options = {}) {
  const explicit = readPositiveInteger(process.env.MANGA_TRANSLATOR_OCR_IMPORT_TIMEOUT_MS);
  if (explicit) {
    return explicit;
  }
  if (isOcrGpuRequested(options)) {
    return isOcrBlackwellCudaTag(options) ? 300000 : 180000;
  }
  return 120000;
}

function buildPaddleOcrImportFailureMessage(importMessage, options = {}) {
  if (isPaddleSm120UnsupportedText(importMessage)) {
    return buildPaddleOcrSm120FailureMessage(importMessage, options);
  }
  if (isPaddleBfloat16SafetensorsText(importMessage)) {
    return buildPaddleOcrBfloat16SafetensorsFailureMessage(importMessage, options);
  }
  if (isPaddleOcrVerificationTimeoutText(importMessage)) {
    const suffix = isOcrGpuRequested(options)
      ? ` GPU 검증이 제한 시간 안에 끝나지 않았습니다. RTX 50번대는 cu129 런타임을 사용하며 첫 실행 검증이 오래 걸릴 수 있지만, 반복되면 NVIDIA 드라이버/CUDA 12.9용 Paddle 런타임 호환성을 확인해야 합니다.`
      : " CPU 런타임 검증이 제한 시간 안에 끝나지 않았습니다.";
    return `Paddle OCR 런타임 설치 후 검증이 시간 초과되었습니다.${suffix} detail=${truncateText(importMessage, 1200)}`;
  }
  const suffix = isOcrGpuRequested(options)
    ? " GPU를 선택했지만 GPU Paddle/CUDA 검증에 실패했습니다. CPU로 바꾸거나 CUDA 드라이버와 GPU Paddle wheel을 확인하세요."
    : "";
  const detail = importMessage ? ` detail=${truncateText(importMessage, 1200)}` : "";
  return `PaddleOCR-VL runtime was installed but paddleocr/paddlex/paddle imports still fail.${suffix}${detail}`;
}

function buildPaddleOcrGpuFailureMessage(error, options = {}) {
  const text = summarizeOcrErrorMessage(error);
  if (isPaddleSm120UnsupportedText(text)) {
    return buildPaddleOcrSm120FailureMessage(text, options);
  }
  if (isPaddleBfloat16SafetensorsText(text)) {
    return buildPaddleOcrBfloat16SafetensorsFailureMessage(text, options);
  }
  return `Paddle OCR GPU 실행에 실패했습니다. GPU 설정을 쓰려면 CUDA가 보이는 GPU Paddle 런타임이 필요합니다. CPU로 바꾸면 계속 진행할 수 있습니다. detail=${truncateText(text, 1200)}`;
}

function buildPaddleOcrSm120FailureMessage(detail, options = {}) {
  return `RTX 50번대/SM120에서 현재 Paddle OCR GPU 런타임이 맞지 않습니다. RTX 50번대는 CUDA 12.9용 Paddle OCR 런타임(cu129)을 사용해야 합니다. 설정값은 현재 ${resolveOcrGpuCudaTag(options)}입니다. 기존 gpu-cu126 런타임이 남아 있으면 OCR 런타임을 삭제하고 다시 시도하세요. detail=${truncateText(detail, 1200)}`;
}

function buildPaddleOcrBfloat16SafetensorsFailureMessage(detail, options = {}) {
  return `PaddleOCR-VL 모델 가중치(bfloat16)를 현재 OCR 런타임이 읽지 못했습니다. Windows에서는 PaddleOCR-VL용 special safetensors 휠과 공식 ${resolveOcrGpuCudaTag(options)} Paddle 런타임이 같이 필요합니다. OCR 런타임 패키지가 다시 설치되도록 앱을 업데이트한 뒤 재시도하세요. detail=${truncateText(detail, 1200)}`;
}

function isPaddleSm120UnsupportedText(value) {
  return /not compiled for\s+SM\s*120|sm[_\s-]*120|compute capability:\s*12(?:\.0)?|mismatched gpu architecture/i.test(String(value ?? ""));
}

function isPaddleBfloat16SafetensorsText(value) {
  return /data type ['"]?bfloat16['"]? not understood|_load_part_state_dict_from_safetensors/i.test(String(value ?? ""));
}

function isPaddleOcrVerificationTimeoutText(value) {
  return /Paddle OCR runtime verification timed out|OCR bbox command timed out/i.test(String(value ?? ""));
}

function summarizeOcrErrorMessage(error) {
  if (!error || typeof error !== "object") {
    return String(error ?? "");
  }
  const parts = [
    error.message,
    error.stderrPreview,
    error.stdoutPreview,
    error.cause instanceof Error ? error.cause.message : error.cause
  ].filter(Boolean);
  return parts.length > 0 ? parts.map((part) => String(part)).join(" ") : String(error);
}

function resolveOcrInstallSignature(options = {}) {
  return resolveOcrPipInstallBatches(options)
    .map((batch) => batch.join(" "))
    .join(" | ");
}

function buildPaddleOcrImportCheckScript(options = {}) {
  const device = resolveOcrDevice(options);
  const lines = [
    "import importlib.util",
    "missing = [name for name in ('paddle', 'paddlex', 'paddleocr') if importlib.util.find_spec(name) is None]",
    "assert not missing, 'Missing Paddle OCR package(s): ' + ', '.join(missing)",
    "import paddle",
    "from paddleocr import PaddleOCRVL, PaddleOCR"
  ];
  if (device.startsWith("gpu")) {
    lines.push("assert paddle.device.is_compiled_with_cuda(), 'PaddlePaddle is not compiled with CUDA'");
    lines.push("count = paddle.device.cuda.device_count()");
    lines.push("assert count > 0, 'No CUDA device is visible to PaddlePaddle'");
    lines.push(`paddle.set_device(${JSON.stringify(device)})`);
  }
  return lines.join("; ");
}

function buildOcrRuntimeEnv(options = {}, runtime = null) {
  const runtimeDir = runtime?.runtimeDir || resolveOcrRuntimeDir(options);
  const hfHomeDir = options.hfHomeDir || runtimeOverrideEnv("HF_HOME", options) || path.join(runtimeDir, "hf-cache");
  const hfHubCacheDir =
    options.hfHubCacheDir ||
    runtimeOverrideEnv("HF_HUB_CACHE", options) ||
    runtimeOverrideEnv("HUGGINGFACE_HUB_CACHE", options) ||
    path.join(hfHomeDir, "hub");
  const packageDir = runtime?.packageDir || resolveOcrPythonPackageDir(runtimeDir, options);
  const includePackageDir = runtime?.includePackageDir ?? runtime?.usesTargetPackageDir ?? true;
  const pythonPath = includePackageDir ? packageDir : "";
  const ocrDevice = resolveOcrDevice(options);
  const pipCacheDir = path.join(runtimeDir, "pip-cache");
  const tempDir = path.join(runtimeDir, "tmp");
  const env = buildWhitelistedChildEnv({
    pathDirs: buildOcrRuntimePathDirs(options, runtime, runtimeDir),
    includeProcessPath: shouldAllowExternalRuntimeOverrides(options),
    extraKeys: [...NETWORK_CHILD_ENV_KEYS, ...HF_CHILD_ENV_KEYS]
  });
  return {
    ...env,
    HF_HOME: hfHomeDir,
    HF_HUB_CACHE: hfHubCacheDir,
    HUGGINGFACE_HUB_CACHE: hfHubCacheDir,
    HF_HUB_DISABLE_XET: runtimeOverrideEnv("HF_HUB_DISABLE_XET", options) || "1",
    HF_HUB_ETAG_TIMEOUT: runtimeOverrideEnv("HF_HUB_ETAG_TIMEOUT", options) || "30",
    HF_HUB_DOWNLOAD_TIMEOUT: runtimeOverrideEnv("HF_HUB_DOWNLOAD_TIMEOUT", options) || "300",
    MANGA_TRANSLATOR_OCR_DEVICE: options.ocrDevice || runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_DEVICE", options) || "cpu",
    MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG: resolveOcrGpuCudaTag(options),
    MANGA_TRANSLATOR_PADDLEOCR_DEVICE: ocrDevice,
    PYTHONPATH: pythonPath,
    PYTHONNOUSERSITE: "1",
    PYTHONUSERBASE: path.join(runtimeDir, "python-user-base"),
    PIP_CACHE_DIR: pipCacheDir,
    PADDLE_PDX_MODEL_SOURCE: runtimeOverrideEnv("PADDLE_PDX_MODEL_SOURCE", options) || "huggingface",
    PADDLE_PDX_CACHE_HOME: runtimeOverrideEnv("PADDLE_PDX_CACHE_HOME", options) || path.join(runtimeDir, "paddlex-cache"),
    PADDLE_PDX_HUGGING_FACE_ENDPOINT: runtimeOverrideEnv("PADDLE_PDX_HUGGING_FACE_ENDPOINT", options) || "https://huggingface.co",
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: runtimeOverrideEnv("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", options) || "True",
    PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT: runtimeOverrideEnv("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", options) || "0",
    PIP_DISABLE_PIP_VERSION_CHECK: runtimeOverrideEnv("PIP_DISABLE_PIP_VERSION_CHECK", options) || "1",
    TMP: tempDir,
    TEMP: tempDir,
    PYTHONUTF8: "1",
    PYTHONUNBUFFERED: "1"
  };
}

function buildOcrRuntimePathDirs(options = {}, runtime = null, runtimeDir = resolveOcrRuntimeDir(options)) {
  const variant = resolveOcrRuntimeVariant(options);
  const venvBinDir = process.platform === "win32"
    ? path.join(runtimeDir, `.venv-${variant}`, "Scripts")
    : path.join(runtimeDir, `.venv-${variant}`, "bin");
  const toolsDir = resolveToolsDir(options);
  return [
    runtime?.pythonPath ? path.dirname(runtime.pythonPath) : null,
    venvBinDir,
    path.join(toolsDir || "", "python"),
    path.join(toolsDir || "", "python", "python-embed"),
    runtimeDir
  ];
}

module.exports = {
  buildOcrRuntimeEnv,
  buildPaddleOcrGpuFailureMessage,
  buildPaddleOcrImportCheckScript,
  buildPaddleOcrImportFailureMessage,
  isOcrGpuRequested,
  isPaddleBfloat16SafetensorsText,
  isPaddleSm120UnsupportedText,
  resolveBootstrapPython,
  resolveInstallProgressDir,
  resolveOcrDevice,
  resolveOcrDeviceLabel,
  resolveOcrGpuCudaTag,
  resolveOcrGpuPackageIndexUrl,
  resolveOcrInstallSignature,
  resolveOcrPipInstallBatches,
  resolveOcrPythonPackageDir,
  resolveOcrRuntimeDir,
  resolveOcrRuntimeVariant,
  resolvePaddleOcrImportCheckTimeoutMs,
  resolveVenvPythonPath,
  shouldAllowSystemPythonFallback,
  summarizeOcrInstallBatches,
  summarizeOcrErrorMessage
};
