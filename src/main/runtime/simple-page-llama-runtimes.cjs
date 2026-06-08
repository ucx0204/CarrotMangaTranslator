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
      url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.2.0/beellama-v0.2.0-bin-win-cuda-12.4-x64.zip"
    },
    {
      archive: "cudart-llama-bin-win-cuda-12.4-x64.zip",
      url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.2.0/cudart-llama-bin-win-cuda-12.4-x64.zip"
    }
  ],
  requiredFiles: [
    "llama-server.exe",
    ["ggml-cuda.dll", "ggml-cuda-cu12.dll"],
    ["cublas64_12.dll"],
    ["cublasLt64_12.dll"],
    ["cudart64_12.dll"]
  ]
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
      url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.2.0/beellama-v0.2.0-bin-win-cuda-13.1-x64.zip"
    },
    {
      archive: "cudart-llama-bin-win-cuda-13.1-x64.zip",
      url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.2.0/cudart-llama-bin-win-cuda-13.1-x64.zip"
    }
  ],
  requiredFiles: [
    "llama-server.exe",
    ["ggml-cuda.dll", "ggml-cuda-cu13.dll"],
    ["cublas64_13.dll", "cublas64_12.dll"],
    ["cublasLt64_13.dll", "cublasLt64_12.dll"],
    ["cudart64_13.dll", "cudart64_12.dll"]
  ]
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
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b9547/llama-b9547-bin-win-cuda-12.4-x64.zip"
    },
    {
      archive: "cudart-llama-bin-win-cuda-12.4-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b9547/cudart-llama-bin-win-cuda-12.4-x64.zip"
    }
  ],
  requiredFiles: [
    "llama-server.exe",
    "llama-server-impl.dll",
    ["ggml-cuda.dll", "ggml-cuda-cu12.dll"],
    ["cublas64_12.dll"],
    ["cublasLt64_12.dll"],
    ["cudart64_12.dll"]
  ]
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
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b9547/llama-b9547-bin-win-cuda-13.3-x64.zip"
    },
    {
      archive: "cudart-llama-bin-win-cuda-13.3-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b9547/cudart-llama-bin-win-cuda-13.3-x64.zip"
    }
  ],
  requiredFiles: [
    "llama-server.exe",
    "llama-server-impl.dll",
    ["ggml-cuda.dll", "ggml-cuda-cu13.dll"],
    ["cublas64_13.dll", "cublas64_12.dll"],
    ["cublasLt64_13.dll", "cublasLt64_12.dll"],
    ["cudart64_13.dll", "cudart64_12.dll"]
  ]
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
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b9547/llama-b9547-bin-win-vulkan-x64.zip"
    }
  ],
  requiredFiles: [
    "llama-server.exe",
    "llama-server-impl.dll",
    ["ggml-vulkan.dll", "libggml-vulkan.so"]
  ]
};

const MAINLINE_LLAMA_RUNTIME_ROCM = {
  id: "llama-b9547-rocm",
  kind: "mainline",
  backend: "rocm",
  dir: "llama-b9547-rocm",
  archive: "llama-b9547-bin-win-hip-radeon-x64.zip",
  url: "https://github.com/ggml-org/llama.cpp/releases/download/b9547/llama-b9547-bin-win-hip-radeon-x64.zip",
  archives: [
    {
      archive: "llama-b9547-bin-win-hip-radeon-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b9547/llama-b9547-bin-win-hip-radeon-x64.zip"
    }
  ],
  requiredFiles: [
    "llama-server.exe",
    "llama-server-impl.dll",
    ["ggml-hip.dll", "ggml-rocm.dll", "libggml-hip.so", "libggml-rocm.so"]
  ]
};

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
  "hiprtc0506.dll",
  "hiprtc-builtins.dll",
  "amdhip64.dll",
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
  "llama-cli",
  "llama-server",
  "llama-common.dll",
  "llama-server-impl.dll",
  "llama-server.exe",
  "llama.dll",
  "mtmd.dll",
  "rpc-server.exe"
]);

module.exports = {
  BEELLAMA_LLAMA_RUNTIME_CUDA12,
  BEELLAMA_LLAMA_RUNTIME_CUDA13,
  LLAMA_RUNTIME_FILES,
  LLAMA_RUNTIME_MARKER_FILE,
  MAINLINE_LLAMA_RUNTIME_CUDA12,
  MAINLINE_LLAMA_RUNTIME_CUDA13,
  MAINLINE_LLAMA_RUNTIME_ROCM,
  MAINLINE_LLAMA_RUNTIME_VULKAN
};
