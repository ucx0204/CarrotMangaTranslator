// @ts-check
const BEELLAMA_LLAMA_RUNTIME_CUDA12 = {
  id: "beellama-v0.2.0-cuda12.4",
  kind: "beellama",
  backend: "cuda",
  dir: "beellama-v0.2.0-cuda12.4",
  archive: "beellama-v0.2.0-bin-win-cuda-12.4-x64.zip",
  url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.2.0/beellama-v0.2.0-bin-win-cuda-12.4-x64.zip",
  archives: [
    {
      archive: "beellama-v0.2.0-bin-win-cuda-12.4-x64.zip",
      url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.2.0/beellama-v0.2.0-bin-win-cuda-12.4-x64.zip",
    },
    {
      archive: "cudart-llama-bin-win-cuda-12.4-x64.zip",
      url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.2.0/cudart-llama-bin-win-cuda-12.4-x64.zip",
    },
  ],
  requiredFiles: [
    "llama-server.exe",
    ["ggml-cuda.dll", "ggml-cuda-cu12.dll"],
    ["cublas64_12.dll"],
    ["cublasLt64_12.dll"],
    ["cudart64_12.dll"],
  ],
};

const BEELLAMA_LLAMA_RUNTIME_CUDA13 = {
  id: "beellama-v0.2.0-cuda13.1",
  kind: "beellama",
  backend: "cuda",
  dir: "beellama-v0.2.0-cuda13.1",
  archive: "beellama-v0.2.0-bin-win-cuda-13.1-x64.zip",
  url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.2.0/beellama-v0.2.0-bin-win-cuda-13.1-x64.zip",
  archives: [
    {
      archive: "beellama-v0.2.0-bin-win-cuda-13.1-x64.zip",
      url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.2.0/beellama-v0.2.0-bin-win-cuda-13.1-x64.zip",
    },
    {
      archive: "cudart-llama-bin-win-cuda-13.1-x64.zip",
      url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.2.0/cudart-llama-bin-win-cuda-13.1-x64.zip",
    },
  ],
  requiredFiles: [
    "llama-server.exe",
    ["ggml-cuda.dll", "ggml-cuda-cu13.dll"],
    ["cublas64_13.dll", "cublas64_12.dll"],
    ["cublasLt64_13.dll", "cublasLt64_12.dll"],
    ["cudart64_13.dll", "cudart64_12.dll"],
  ],
};

const BEELLAMA_LLAMA_RUNTIME_HIP_RADEON = {
  id: "beellama-v0.3.1-hip-radeon",
  kind: "beellama-hip",
  backend: "rocm",
  dir: "beellama-v0.3.1-hip-radeon",
  archive: "beellama-v0.3.1-bin-win-hip-radeon-x64.zip",
  url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.3.1/beellama-v0.3.1-bin-win-hip-radeon-x64.zip",
  archives: [
    {
      archive: "beellama-v0.3.1-bin-win-hip-radeon-x64.zip",
      url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.3.1/beellama-v0.3.1-bin-win-hip-radeon-x64.zip",
    },
  ],
  requiredFiles: [
    "llama-server.exe",
    "llama-server-impl.dll",
    "llama.dll",
    "ggml-hip.dll",
    "rocblas.dll",
    ["libhipblas.dll", "hipblas.dll"],
    "libhipblaslt.dll",
  ],
};

const MAINLINE_LLAMA_RUNTIME_CUDA12 = {
  id: "llama-b9547-cuda12.4",
  kind: "mainline",
  backend: "cuda",
  dir: "llama-b9547-cuda12.4",
  archive: "llama-b9547-bin-win-cuda-12.4-x64.zip",
  url: "https://github.com/ggml-org/llama.cpp/releases/download/b9547/llama-b9547-bin-win-cuda-12.4-x64.zip",
  archives: [
    {
      archive: "llama-b9547-bin-win-cuda-12.4-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b9547/llama-b9547-bin-win-cuda-12.4-x64.zip",
    },
    {
      archive: "cudart-llama-bin-win-cuda-12.4-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b9547/cudart-llama-bin-win-cuda-12.4-x64.zip",
    },
  ],
  requiredFiles: [
    "llama-server.exe",
    "llama-server-impl.dll",
    ["ggml-cuda.dll", "ggml-cuda-cu12.dll"],
    ["cublas64_12.dll"],
    ["cublasLt64_12.dll"],
    ["cudart64_12.dll"],
  ],
};

const MAINLINE_LLAMA_RUNTIME_CUDA13 = {
  id: "llama-b9547-cuda13.3",
  kind: "mainline",
  backend: "cuda",
  dir: "llama-b9547-cuda13.3",
  archive: "llama-b9547-bin-win-cuda-13.3-x64.zip",
  url: "https://github.com/ggml-org/llama.cpp/releases/download/b9547/llama-b9547-bin-win-cuda-13.3-x64.zip",
  archives: [
    {
      archive: "llama-b9547-bin-win-cuda-13.3-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b9547/llama-b9547-bin-win-cuda-13.3-x64.zip",
    },
    {
      archive: "cudart-llama-bin-win-cuda-13.3-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b9547/cudart-llama-bin-win-cuda-13.3-x64.zip",
    },
  ],
  requiredFiles: [
    "llama-server.exe",
    "llama-server-impl.dll",
    ["ggml-cuda.dll", "ggml-cuda-cu13.dll"],
    ["cublas64_13.dll", "cublas64_12.dll"],
    ["cublasLt64_13.dll", "cublasLt64_12.dll"],
    ["cudart64_13.dll", "cudart64_12.dll"],
  ],
};

const MAINLINE_LLAMA_RUNTIME_VULKAN = {
  id: "llama-b9547-vulkan",
  kind: "mainline",
  backend: "vulkan",
  dir: "llama-b9547-vulkan",
  archive: "llama-b9547-bin-win-vulkan-x64.zip",
  url: "https://github.com/ggml-org/llama.cpp/releases/download/b9547/llama-b9547-bin-win-vulkan-x64.zip",
  archives: [
    {
      archive: "llama-b9547-bin-win-vulkan-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b9547/llama-b9547-bin-win-vulkan-x64.zip",
    },
  ],
  requiredFiles: [
    "llama-server.exe",
    "llama-server-impl.dll",
    ["ggml-vulkan.dll", "libggml-vulkan.so"],
  ],
};

const MAINLINE_LLAMA_RUNTIME_METAL_ARM64 = {
  id: "llama-b9547-metal-arm64",
  kind: "mainline-metal",
  backend: "metal",
  platform: "darwin",
  arch: "arm64",
  dir: "llama-b9547-metal-arm64",
  archive: "llama-b9547-bin-macos-arm64.tar.gz",
  url: "https://github.com/ggml-org/llama.cpp/releases/download/b9547/llama-b9547-bin-macos-arm64.tar.gz",
  archives: [
    {
      archive: "llama-b9547-bin-macos-arm64.tar.gz",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b9547/llama-b9547-bin-macos-arm64.tar.gz",
      sha256:
        "8791fdac4d5b7008b53fd15c609491d5a2fce2d180bb0b0e041eac53c5ade000",
      type: "tar.gz",
      stripComponents: 1,
    },
  ],
  requiredFiles: [
    "llama-server",
    ["libggml.dylib", "libggml-base.dylib"],
    ["libggml-metal.dylib", "libggml-metal.0.dylib"],
    ["libllama.dylib", "libllama.0.dylib"],
  ],
};

const BEELLAMA_LLAMA_RUNTIME_METAL_ARM64 = {
  id: "beellama-v0.3.1-metal-arm64",
  kind: "beellama-metal",
  backend: "metal",
  platform: "darwin",
  arch: "arm64",
  dflashRing: "cpu",
  dir: "beellama-v0.3.1-metal-arm64",
  archive: "beellama-v0.3.1-bin-macos-arm64.tar.gz",
  url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.3.1/beellama-v0.3.1-bin-macos-arm64.tar.gz",
  archives: [
    {
      archive: "beellama-v0.3.1-bin-macos-arm64.tar.gz",
      url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.3.1/beellama-v0.3.1-bin-macos-arm64.tar.gz",
      sha256:
        "14c0af87fc124e50469279ceae96016bbc6f7649de484b1de8a0a38675004556",
      type: "tar.gz",
      stripComponents: 1,
    },
  ],
  requiredFiles: [
    "llama-server",
    ["libggml.dylib", "libggml-base.dylib"],
    ["libggml-metal.dylib", "libggml-metal.0.dylib"],
    ["libllama.dylib", "libllama.0.dylib"],
  ],
};

const LEMONADE_LLAMA_ROCM_RELEASE = "b1291";
const LEMONADE_LLAMA_ROCM_BASE_URL = `https://github.com/lemonade-sdk/llamacpp-rocm/releases/download/${LEMONADE_LLAMA_ROCM_RELEASE}`;

/**
 * @param {string} target
 */
function createLemonadeLlamaRuntimeRocm(target) {
  const archive = `llama-${LEMONADE_LLAMA_ROCM_RELEASE}-windows-rocm-${target}-x64.zip`;
  return {
    id: `lemonade-llama-${LEMONADE_LLAMA_ROCM_RELEASE}-rocm-${target}`,
    kind: "lemonade-rocm",
    backend: "rocm",
    dir: `lemonade-llama-${LEMONADE_LLAMA_ROCM_RELEASE}-rocm-${target}`,
    archive,
    url: `${LEMONADE_LLAMA_ROCM_BASE_URL}/${archive}`,
    archives: [
      {
        archive,
        url: `${LEMONADE_LLAMA_ROCM_BASE_URL}/${archive}`,
      },
    ],
    requiredFiles: [
      "llama-server.exe",
      ["llama-server-impl.dll", "llama.dll"],
      ["amdhip64.dll", "amdhip64_7.dll"],
      ["ggml-hip.dll", "ggml-rocm.dll", "libggml-hip.so", "libggml-rocm.so"],
    ],
  };
}

/**
 * @param {unknown} target
 */
function resolveLemonadeLlamaRuntimeRocm(target) {
  const normalized = String(target || "").trim();
  if (!normalized) {
    throw new Error("AMD ROCm GPU target is required.");
  }
  return createLemonadeLlamaRuntimeRocm(normalized);
}

const LLAMA_RUNTIME_MARKER_FILE = ".mgt-runtime.json";
const LLAMA_RUNTIME_FILES = new Set([
  "LICENSE",
  "cublas64_12.dll",
  "cublas64_13.dll",
  "cublasLt64_12.dll",
  "cublasLt64_13.dll",
  "cudart64_12.dll",
  "cudart64_13.dll",
  "ggml-base.dll",
  "ggml-cpu.dll",
  "ggml-cpu-alderlake.dll",
  "ggml-cpu-cannonlake.dll",
  "ggml-cpu-cascadelake.dll",
  "ggml-cpu-cooperlake.dll",
  "ggml-cpu-haswell.dll",
  "ggml-cpu-icelake.dll",
  "ggml-cpu-ivybridge.dll",
  "ggml-cpu-piledriver.dll",
  "ggml-cpu-sandybridge.dll",
  "ggml-cpu-sapphirerapids.dll",
  "ggml-cpu-skylakex.dll",
  "ggml-cpu-sse42.dll",
  "ggml-cpu-x64.dll",
  "ggml-cpu-zen4.dll",
  "ggml-cuda.dll",
  "ggml-cuda-cu12.dll",
  "ggml-cuda-cu13.dll",
  "ggml-hip.dll",
  "ggml-rocm.dll",
  "ggml-rpc.dll",
  "ggml-vulkan.dll",
  "ggml-hip.so",
  "ggml-rocm.so",
  "ggml-vulkan.so",
  "ggml.dll",
  "hipblas.dll",
  "libhipblas.dll",
  "libhipblaslt.dll",
  "hiprtc0506.dll",
  "hiprtc-builtins.dll",
  "amdhip64.dll",
  "amdhip64_7.dll",
  "rocblas.dll",
  "rocblas64.dll",
  "rocsolver.dll",
  "libomp140.x86_64.dll",
  "libggml.so",
  "libggml-base.so",
  "libggml-cpu.so",
  "libggml-hip.so",
  "libggml-rocm.so",
  "libggml-vulkan.so",
  "libggml.dylib",
  "libggml-base.dylib",
  "libggml-cpu.dylib",
  "libggml-metal.dylib",
  "libllama.dylib",
  "libmtmd.dylib",
  "ggml-metal.metal",
  "default.metallib",
  "llama-cli",
  "llama-server",
  "llama-common.dll",
  "llama-server-impl.dll",
  "llama-server.exe",
  "llama.dll",
  "mtmd.dll",
  "rpc-server.exe",
]);

/**
 * @param {string} fileName
 * @param {string} [relativePath]
 * @returns {boolean}
 */
function shouldExtractLlamaRuntimeFile(fileName, relativePath = fileName) {
  const normalizedRelativePath = String(relativePath ?? fileName ?? "")
    .replace(/\\/g, "/")
    .toLowerCase();
  if (
    (normalizedRelativePath.startsWith("rocblas/") ||
      normalizedRelativePath.startsWith("hipblaslt/")) &&
    /\.(?:dat|co|hsaco)$/i.test(normalizedRelativePath)
  ) {
    return true;
  }
  return (
    LLAMA_RUNTIME_FILES.has(fileName) ||
    /\.(?:dll|so|dylib|metal|metallib)$/i.test(String(fileName ?? ""))
  );
}

module.exports = {
  BEELLAMA_LLAMA_RUNTIME_CUDA12,
  BEELLAMA_LLAMA_RUNTIME_CUDA13,
  BEELLAMA_LLAMA_RUNTIME_HIP_RADEON,
  BEELLAMA_LLAMA_RUNTIME_METAL_ARM64,
  LLAMA_RUNTIME_FILES,
  LLAMA_RUNTIME_MARKER_FILE,
  MAINLINE_LLAMA_RUNTIME_CUDA12,
  MAINLINE_LLAMA_RUNTIME_CUDA13,
  MAINLINE_LLAMA_RUNTIME_VULKAN,
  MAINLINE_LLAMA_RUNTIME_METAL_ARM64,
  resolveLemonadeLlamaRuntimeRocm,
  shouldExtractLlamaRuntimeFile,
};
