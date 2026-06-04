const BEELLAMA_LLAMA_RUNTIME_CUDA12 = {
  id: "beellama-v0.2.0-cuda12.4",
  kind: "beellama",
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
  id: "llama-b8833-cuda12.4",
  kind: "mainline",
  dir: "llama-b8833-cuda12.4",
  archive: "llama-b8833-bin-win-cuda-12.4-x64.zip",
  url: "https://github.com/ggml-org/llama.cpp/releases/download/b8833/llama-b8833-bin-win-cuda-12.4-x64.zip",
  archives: [
    {
      archive: "llama-b8833-bin-win-cuda-12.4-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b8833/llama-b8833-bin-win-cuda-12.4-x64.zip"
    },
    {
      archive: "cudart-llama-bin-win-cuda-12.4-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b8833/cudart-llama-bin-win-cuda-12.4-x64.zip"
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

const MAINLINE_LLAMA_RUNTIME_CUDA13 = {
  id: "llama-b9360-cuda13.1",
  kind: "mainline",
  dir: "llama-b9360-cuda13.1",
  archive: "llama-b9360-bin-win-cuda-13.1-x64.zip",
  url: "https://github.com/ggml-org/llama.cpp/releases/download/b9360/llama-b9360-bin-win-cuda-13.1-x64.zip",
  archives: [
    {
      archive: "llama-b9360-bin-win-cuda-13.1-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b9360/llama-b9360-bin-win-cuda-13.1-x64.zip"
    },
    {
      archive: "cudart-llama-bin-win-cuda-13.1-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b9360/cudart-llama-bin-win-cuda-13.1-x64.zip"
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
  "ggml-rpc.dll",
  "ggml.dll",
  "libomp140.x86_64.dll",
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
  MAINLINE_LLAMA_RUNTIME_CUDA13
};
