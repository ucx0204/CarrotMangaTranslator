import type { FluxWorkerBackend } from "./fluxWorkerTypes";

export function sanitizeFluxRuntimeStderr(text: string): string {
  return text
    .replace(
      /[A-Z]:\\Users\\[^\\\r\n]+\\\.cargo\\registry\\src\\[^:\r\n]+/gi,
      "<rust-crate-source>",
    )
    .replace(
      /[A-Z]:\\Users\\[^\\\r\n]+\\\.cargo\\git\\checkouts\\[^:\r\n]+/gi,
      "<rust-git-source>",
    )
    .replace(
      /[A-Z]:\\Users\\[^\\\r\n]+\\CARGO~1\\registry\\src\\[^:\r\n]+/gi,
      "<rust-crate-source>",
    )
    .replace(
      /[A-Z]:\\Users\\[^:\r\n]+?\\tools\\mgt-flux-klein-runner\\[^:\r\n]+/gi,
      "<flux-runner-source>",
    )
    .replace(
      /\/Users\/[^/\r\n]+\/(?:\.cargo\/(?:registry\/src|git\/checkouts)|[^:\r\n]*?\/tools\/mgt-flux-klein-runner)\/[^:\r\n]+/g,
      "<flux-runner-source>",
    )
    .replace(
      /[A-Z]:\\Users\\[^\\\r\n]+\\Downloads\\[^:\r\n]+?\\tools\\mgt-flux-klein-runner\\[^:\r\n]+/gi,
      "<flux-runner-source>",
    );
}

export function buildFluxRuntimeExitError(
  code: number | null,
  stderr: string,
  backend: FluxWorkerBackend,
): Error {
  const detail = formatFluxRuntimeDetail(stderr);
  return (
    buildMetalRuntimeExitError(stderr, detail, code, backend) ??
    buildZludaRuntimeExitError(stderr, detail, code, backend) ??
    buildPythonRuntimeExitError(stderr, detail, code, backend) ??
    buildCudaRuntimeExitError(stderr, detail, code)
  );
}

function buildMetalRuntimeExitError(
  stderr: string,
  detail: string,
  code: number | null,
  backend: FluxWorkerBackend,
): Error | null {
  if (backend !== "metal-native") {
    return null;
  }
  if (
    /Metal.*(?:unavailable|not available)|no Metal device|new_metal/i.test(
      stderr,
    )
  ) {
    return new Error(
      `Apple Metal 장치를 사용할 수 없어 Flux를 시작하지 못했습니다. Flux는 macOS에서 CPU나 다른 모델로 자동 전환하지 않습니다. ${detail}`,
    );
  }
  return new Error(
    `Apple Metal Flux 인페인팅 런타임이 종료되었습니다 (${code}). ${detail}`,
  );
}

export function buildFluxWorkerResponseError(
  message: string,
  stderr: string,
  backend: FluxWorkerBackend,
): Error {
  const detail = formatFluxRuntimeDetail(stderr);
  const combined = `${message}\n${stderr}`;
  if (backend === "cuda-native") {
    const cudaError = buildCudaNativeWorkerResponseError(
      message,
      detail,
      combined,
    );
    if (cudaError) {
      return cudaError;
    }
  }
  if (backend === "zluda-native") {
    const zludaError = buildZludaWorkerResponseError(message, detail, combined);
    if (zludaError) {
      return zludaError;
    }
  }
  return new Error(
    `Flux 인페인팅 실패: ${message}${detail ? ` ${detail}` : ""}`,
  );
}

function buildZludaRuntimeExitError(
  stderr: string,
  detail: string,
  code: number | null,
  backend: FluxWorkerBackend,
): Error | null {
  if (backend !== "zluda-native") {
    return null;
  }
  if (
    /HIP SDK not found|HIP_PATH|amdhip64|ZLUDA.*unavailable|ZLUDA.*not active/i.test(
      stderr,
    )
  ) {
    return new Error(
      `AMD ZLUDA Flux 런타임을 준비하지 못했습니다. AMD HIP SDK가 설치되어 있고 HIP_PATH가 올바른지 확인하세요. ${detail}`,
    );
  }
  if (
    /Unable to dynamically load the "cublas"|cublas64_12\.dll|cublas\.dll|cublas64\.dll/i.test(
      stderr,
    )
  ) {
    return new Error(
      `AMD ZLUDA Flux 런타임이 cuBLAS 호환 DLL을 찾지 못했습니다. 앱이 ZLUDA DLL alias를 자동으로 준비하므로, 최신 설치 파일로 업데이트한 뒤 Flux 런타임을 다시 준비하세요. ${detail}`,
    );
  }
  if (
    /Unable to dynamically load the "curand"|curand64_10\.dll|curand\.dll|curand64\.dll/i.test(
      stderr,
    )
  ) {
    return new Error(
      `AMD ZLUDA Flux 런타임이 cuRAND DLL(curand64_10.dll)을 찾지 못했습니다. 앱이 Flux CUDA 보조 DLL을 자동으로 준비해야 하므로, 최신 설치 파일로 업데이트한 뒤 Flux 런타임을 다시 준비하세요. ${detail}`,
    );
  }
  if (
    /ZLUDA|nvcuda|cublas64_13|cublasLt64_13|cufft64_12|cudnn64_9|hipError|HSA|amdgpu|gfx/i.test(
      stderr,
    )
  ) {
    return new Error(
      `AMD ZLUDA Flux 런타임이 GPU 실행에 실패했습니다. AMD 드라이버/HIP SDK/ZLUDA 런타임 조합을 확인하세요. ${detail}`,
    );
  }
  return new Error(
    `AMD ZLUDA Flux 인페인팅 런타임이 종료되었습니다 (${code}). ${detail}`,
  );
}

function buildPythonRuntimeExitError(
  stderr: string,
  detail: string,
  code: number | null,
  backend: FluxWorkerBackend,
): Error | null {
  if (backend === "python-rocm") {
    return buildPythonRocmRuntimeExitError(stderr, detail, code);
  }
  if (backend === "python-cpu") {
    return buildPythonCpuRuntimeExitError(stderr, detail, code);
  }
  return null;
}

function buildPythonRocmRuntimeExitError(
  stderr: string,
  detail: string,
  code: number | null,
): Error {
  if (/ModuleNotFoundError|No module named/i.test(stderr)) {
    return new Error(
      `Flux stable-diffusion.cpp ROCm 런타임 패키지를 불러오지 못했습니다. Flux 런타임 설치를 다시 실행하세요. ${detail}`,
    );
  }
  if (
    /ROCm|HIP|hipError|HSA|gfx|hipblas|rocblas|amdgpu|GPU_TARGETS|AMDGPU_TARGETS/i.test(
      stderr,
    )
  ) {
    return new Error(
      `Flux stable-diffusion.cpp ROCm/HIP 런타임이 AMD GPU를 사용할 수 없습니다. AMD 드라이버, ROCm/HIP 지원 아키텍처, GPU target 설정을 확인하세요. ${detail}`,
    );
  }
  return new Error(
    `Flux stable-diffusion.cpp ROCm 인페인팅 런타임이 종료되었습니다 (${code}). ${detail}`,
  );
}

function buildPythonCpuRuntimeExitError(
  stderr: string,
  detail: string,
  code: number | null,
): Error {
  if (/ModuleNotFoundError|No module named/i.test(stderr)) {
    return new Error(
      `Flux Python CPU 런타임 패키지를 불러오지 못했습니다. Flux 런타임 설치를 다시 실행하세요. ${detail}`,
    );
  }
  return new Error(
    `Flux Python CPU 인페인팅 런타임이 종료되었습니다 (${code}). ${detail}`,
  );
}

function buildCudaRuntimeExitError(
  stderr: string,
  detail: string,
  code: number | null,
): Error {
  if (
    /Unable to dynamically load the "cublas"|cublas64_12\.dll|cublas\.dll/i.test(
      stderr,
    )
  ) {
    return new Error(
      `Flux 인페인팅 런타임이 CUDA cuBLAS DLL(cublas64_12.dll)을 찾지 못했습니다. 앱에 포함된 CUDA 런타임 경로를 확인하세요. ${detail}`,
    );
  }
  if (
    /Unable to dynamically load the "curand"|curand64_10\.dll|curand\.dll/i.test(
      stderr,
    )
  ) {
    return new Error(
      `Flux 인페인팅 런타임이 CUDA cuRAND DLL(curand64_10.dll)을 찾지 못했습니다. 앱의 Flux CUDA 런타임을 다시 준비해야 합니다. ${detail}`,
    );
  }
  if (
    /Unable to dynamically load the "cudnn"|cudnn64(?:_9|_12)?\.dll|cudnn\.dll/i.test(
      stderr,
    )
  ) {
    return new Error(
      `Flux 인페인팅 런타임이 cuDNN DLL(cudnn64_9.dll)을 찾지 못했습니다. 최신 설치 파일로 업데이트하거나 앱의 Flux CUDA 런타임을 다시 준비해야 합니다. ${detail}`,
    );
  }
  if (isFluxBlackwellRuntimeError(stderr)) {
    return new Error(
      `RTX 50번대/Blackwell에서 Flux CUDA 커널 실행에 실패했습니다. Flux는 앱이 준비한 CUDA 12.9/cuDNN 9.21 런타임만 사용해야 합니다. 앱을 최신 설치 파일로 업데이트하고 Flux 런타임 캐시를 다시 준비하세요. ${detail}`,
    );
  }
  if (isFluxInvalidPtxRuntimeError(stderr)) {
    return new Error(
      `Flux CUDA 커널이 현재 NVIDIA GPU 아키텍처와 맞지 않아 실행되지 않았습니다. 앱을 최신 설치 파일로 업데이트해 GPU별 Flux 실행 파일을 받거나, 설정에서 인페인팅 Flux 백엔드를 CPU로 바꾼 뒤 앱을 다시 시작해 주세요. ${detail}`,
    );
  }
  return new Error(
    `Flux 인페인팅 런타임이 종료되었습니다 (${code}). ${detail}`,
  );
}

function buildZludaWorkerResponseError(
  message: string,
  detail: string,
  combined: string,
): Error | null {
  if (
    /Unable to dynamically load the "curand"|curand64_10\.dll|curand\.dll|curand64\.dll/i.test(
      combined,
    )
  ) {
    return new Error(
      `AMD ZLUDA Flux 실행 중 cuRAND DLL(curand64_10.dll)을 찾지 못했습니다. 최신 설치 파일로 Flux 런타임을 갱신한 뒤 다시 시도하세요. 원인=${message}${detail ? ` ${detail}` : ""}`,
    );
  }
  if (
    /CUDA_ERROR_NOT_FOUND|named symbol not found|symbol not found|invalid device function|invalid device kernel image|DriverError/i.test(
      combined,
    )
  ) {
    return new Error(
      `AMD ZLUDA Flux 실행 중 CUDA 호환 함수 호출에 실패했습니다. 앱의 Flux 런너는 CUDA 13/ZLUDA 우회 경로로 빌드되어야 하며, AMD HIP SDK와 드라이버가 맞아야 합니다. 원인=${message}${detail ? ` ${detail}` : ""}`,
    );
  }
  if (/BF16|fma\.rn\.bf16|flash[_ -]?attn|flash attention/i.test(combined)) {
    return new Error(
      `AMD ZLUDA Flux 실행 중 BF16 또는 Flash Attention 경로가 실패했습니다. 최신 설치 파일로 Flux 런너를 갱신한 뒤 다시 시도하세요. 원인=${message}${detail ? ` ${detail}` : ""}`,
    );
  }
  return null;
}

function buildCudaNativeWorkerResponseError(
  message: string,
  detail: string,
  combined: string,
): Error | null {
  if (isFluxInvalidPtxRuntimeError(combined)) {
    return new Error(
      `Flux CUDA 커널이 현재 NVIDIA GPU 아키텍처와 맞지 않아 실행되지 않았습니다. 앱을 최신 설치 파일로 업데이트해 GPU별 Flux 실행 파일을 받거나, 설정에서 인페인팅 Flux 백엔드를 CPU로 바꾼 뒤 앱을 다시 시작해 주세요. 원인=${message}${detail ? ` ${detail}` : ""}`,
    );
  }
  if (!isFluxCudaKernelSymbolError(combined)) {
    return null;
  }
  return new Error(
    `Flux CUDA 커널/심볼을 현재 NVIDIA GPU에서 찾지 못했습니다. 배포된 Flux 실행 파일이 이 GPU의 compute capability와 맞지 않거나 앱 데이터의 Flux runner 캐시가 오래됐을 수 있습니다. 최신 설치 파일로 업데이트한 뒤 Flux runner 캐시를 갱신하세요. RTX 30번대/Ampere 계열은 sm86용 Flux 실행 파일이 필요합니다. 원인=${message}${detail ? ` ${detail}` : ""}`,
  );
}

function isFluxBlackwellRuntimeError(stderr: string): boolean {
  return /SM\s*120|sm[_\s-]*120|compute capability\s*12(?:\.0)?|no kernel image is available|invalid device function|unsupported gpu architecture|invalid device kernel image|named symbol not found/i.test(
    stderr,
  );
}

function isFluxInvalidPtxRuntimeError(stderr: string): boolean {
  return /CUDA_ERROR_INVALID_PTX|PTX JIT compilation failed|invalid ptx/i.test(
    stderr,
  );
}

function isFluxCudaKernelSymbolError(stderr: string): boolean {
  return /CUDA_ERROR_NOT_FOUND|named symbol not found|CUDA_ERROR_NO_BINARY_FOR_GPU|no kernel image is available|invalid device function|CUDA_ERROR_INVALID_IMAGE|invalid device kernel image|unsupported gpu architecture/i.test(
    stderr,
  );
}

export function formatFluxRuntimeDetail(stderr: string): string {
  const detail = sanitizeFluxRuntimeStderr(stderr)
    .replace(/\s+/g, " ")
    .trim()
    .slice(-1600);
  return detail ? `detail=${detail}` : "";
}
