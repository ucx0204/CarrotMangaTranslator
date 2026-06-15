import {
  FLUX_CPU_TORCH_INDEX_URL,
  FLUX_PYTHON_DEFAULT_MODE,
  FLUX_ROCM_PREBUILT_RUNTIME_URL,
  FLUX_ROCM_WINDOWS_VERSION,
} from "./constants";
import type { FluxPythonBackend, FluxPythonInstallBatch } from "./types";

export function resolvePythonRuntimeInstallBatches(
  backend: FluxPythonBackend,
): FluxPythonInstallBatch[] {
  if (backend === "python-rocm" && process.platform === "win32") {
    const rocmPackageUrls =
      resolveListEnv(
        "MANGA_TRANSLATOR_FLUX_ROCM_PACKAGE_URLS",
        "MGT_FLUX_ROCM_PACKAGE_URLS",
      ) ?? defaultWindowsRocmPackageUrls();
    return [
      {
        id: `windows-rocm-runtime-${FLUX_ROCM_WINDOWS_VERSION}-sdcpp`,
        progressText: "Flux ROCm/HIP 런타임 설치 중",
        detail: `ROCm ${FLUX_ROCM_WINDOWS_VERSION}`,
        installLogLine:
          "AMD Windows ROCm SDK를 stable-diffusion.cpp 빌드용으로 준비합니다.",
        pipArgs: rocmPackageUrls,
      },
    ];
  }

  if (backend === "python-rocm") {
    return [];
  }

  const torchIndexUrl =
    process.env.MANGA_TRANSLATOR_FLUX_CPU_TORCH_INDEX_URL ??
    process.env.MGT_FLUX_CPU_TORCH_INDEX_URL ??
    FLUX_CPU_TORCH_INDEX_URL;
  return [
    {
      id: `cpu-index-${torchIndexUrl}`,
      progressText: "Flux CPU PyTorch 설치 중",
      detail: torchIndexUrl,
      installLogLine: `PyTorch 설치 인덱스: ${torchIndexUrl}`,
      pipArgs: ["--index-url", torchIndexUrl, "torch", "torchvision"],
    },
  ];
}

function defaultWindowsRocmPackageUrls(): string[] {
  const base = windowsRocmBaseUrl();
  const version = FLUX_ROCM_WINDOWS_VERSION;
  return [
    `${base}/rocm_sdk_core-${version}-py3-none-win_amd64.whl`,
    `${base}/rocm_sdk_devel-${version}-py3-none-win_amd64.whl`,
    `${base}/rocm_sdk_libraries_custom-${version}-py3-none-win_amd64.whl`,
    `${base}/rocm-${version}.tar.gz`,
  ];
}

function windowsRocmBaseUrl(): string {
  return (
    process.env.MANGA_TRANSLATOR_FLUX_ROCM_WINDOWS_BASE_URL ??
    process.env.MGT_FLUX_ROCM_WINDOWS_BASE_URL ??
    `https://repo.radeon.com/rocm/windows/rocm-rel-${FLUX_ROCM_WINDOWS_VERSION}`
  );
}

export function resolveFluxRocmPrebuiltRuntimeUrl(): string {
  return (
    process.env.MANGA_TRANSLATOR_FLUX_ROCM_RUNTIME_ARCHIVE_URL ??
    process.env.MGT_FLUX_ROCM_RUNTIME_ARCHIVE_URL ??
    FLUX_ROCM_PREBUILT_RUNTIME_URL
  );
}

export function shouldUsePrebuiltFluxRocmRuntime(): boolean {
  const value =
    process.env.MANGA_TRANSLATOR_FLUX_ROCM_USE_PREBUILT ??
    process.env.MGT_FLUX_ROCM_USE_PREBUILT;
  if (value === undefined) {
    return true;
  }
  return !["0", "false", "no", "n", "off"].includes(
    String(value).trim().toLowerCase(),
  );
}

export function shouldAllowFluxRocmSourceBuildFallback(): boolean {
  const value =
    process.env.MANGA_TRANSLATOR_FLUX_ROCM_ALLOW_SOURCE_BUILD ??
    process.env.MGT_FLUX_ROCM_ALLOW_SOURCE_BUILD;
  return ["1", "true", "yes", "y", "on"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

function resolveListEnv(primary: string, secondary: string): string[] | null {
  const value = process.env[primary] ?? process.env[secondary];
  if (!value) {
    return null;
  }
  const items = value
    .split(/[\r\n, ]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

export function resolvePythonFluxPackages(
  backend: FluxPythonBackend,
): string[] {
  if (backend === "python-rocm") {
    return [
      "--no-build-isolation",
      "--no-cache-dir",
      "--force-reinstall",
      "stable-diffusion-cpp-python",
      "huggingface_hub>=0.36.0",
      "pillow>=10.0.0",
    ];
  }
  return [
    "diffusers>=0.36.0",
    "gguf>=0.17.0",
    "transformers>=4.56.0",
    "accelerate>=1.10.0",
    "safetensors>=0.6.0",
    "huggingface_hub>=0.36.0",
    "pillow>=10.0.0",
    "sentencepiece>=0.2.0",
    "protobuf>=4.25.0",
  ];
}

export function resolvePythonBuildPackages(
  backend: FluxPythonBackend,
): string[] {
  if (backend !== "python-rocm") {
    return [];
  }
  return [
    "scikit-build-core>=0.11.0",
    "cmake>=3.29.0",
    "ninja>=1.11.1",
    "packaging>=24.0",
    "setuptools>=69.0.0",
    "wheel>=0.43.0",
  ];
}

export function resolveFluxPythonMode(): string {
  const normalized = String(
    process.env.MANGA_TRANSLATOR_FLUX_PYTHON_MODE ??
      process.env.MGT_FLUX_PYTHON_MODE ??
      "",
  )
    .trim()
    .toLowerCase();
  return normalized === "flux-fill" ? "flux-fill" : FLUX_PYTHON_DEFAULT_MODE;
}
