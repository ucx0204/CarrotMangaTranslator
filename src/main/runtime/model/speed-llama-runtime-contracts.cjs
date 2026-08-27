// @ts-check

// Speed presets intentionally track a newer official llama.cpp build than
// legacy presets. These immutable contracts never replace a legacy runtime in
// place, so an existing user's old model route remains reproducible.
const SPEED_LLAMA_RUNTIME_CUDA12 = {
  id: "llama-b10621-cuda12.4",
  kind: "mainline",
  backend: "cuda",
  dir: "llama-b10621-cuda12.4",
  archive: "llama-b10621-bin-win-cuda-12.4-x64.zip",
  url: "https://github.com/ggml-org/llama.cpp/releases/download/b10621/llama-b10621-bin-win-cuda-12.4-x64.zip",
  archives: [
    {
      archive: "llama-b10621-bin-win-cuda-12.4-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b10621/llama-b10621-bin-win-cuda-12.4-x64.zip",
      sha256:
        "81c2ff62e14b549cd5c766ccdd5c61f09e821a171655c3047bdccfddc2d1a1e2",
      expectedBytes: 250_464_283,
    },
    {
      archive: "cudart-llama-bin-win-cuda-12.4-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b10621/cudart-llama-bin-win-cuda-12.4-x64.zip",
      sha256:
        "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6",
      expectedBytes: 391_443_627,
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

const SPEED_LLAMA_RUNTIME_CUDA13 = {
  id: "llama-b10621-cuda13.3",
  kind: "mainline",
  backend: "cuda",
  dir: "llama-b10621-cuda13.3",
  archive: "llama-b10621-bin-win-cuda-13.3-x64.zip",
  url: "https://github.com/ggml-org/llama.cpp/releases/download/b10621/llama-b10621-bin-win-cuda-13.3-x64.zip",
  archives: [
    {
      archive: "llama-b10621-bin-win-cuda-13.3-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b10621/llama-b10621-bin-win-cuda-13.3-x64.zip",
      sha256:
        "23549ccc00b6a18d74348e95d4789f7e96c9efb11cf6e3f1b185baef34d7449f",
      expectedBytes: 146_446_450,
    },
    {
      archive: "cudart-llama-bin-win-cuda-13.3-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b10621/cudart-llama-bin-win-cuda-13.3-x64.zip",
      sha256:
        "1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e",
      expectedBytes: 390_970_417,
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

const SPEED_LLAMA_RUNTIME_VULKAN = {
  id: "llama-b10621-vulkan",
  kind: "mainline",
  backend: "vulkan",
  dir: "llama-b10621-vulkan",
  archive: "llama-b10621-bin-win-vulkan-x64.zip",
  url: "https://github.com/ggml-org/llama.cpp/releases/download/b10621/llama-b10621-bin-win-vulkan-x64.zip",
  archives: [
    {
      archive: "llama-b10621-bin-win-vulkan-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b10621/llama-b10621-bin-win-vulkan-x64.zip",
      sha256:
        "2672d85bf87c8280d94dee01eb6a86280046878f70a07d786a93637fa9081163",
      expectedBytes: 34_403_304,
    },
  ],
  requiredFiles: [
    "llama-server.exe",
    "llama-server-impl.dll",
    ["ggml-vulkan.dll", "libggml-vulkan.so"],
  ],
};

const SPEED_LLAMA_RUNTIME_METAL_ARM64 = {
  id: "llama-b10621-metal-arm64",
  kind: "mainline-metal",
  backend: "metal",
  platform: "darwin",
  arch: "arm64",
  dir: "llama-b10621-metal-arm64",
  archive: "llama-b10621-bin-macos-arm64.tar.gz",
  url: "https://github.com/ggml-org/llama.cpp/releases/download/b10621/llama-b10621-bin-macos-arm64.tar.gz",
  archives: [
    {
      archive: "llama-b10621-bin-macos-arm64.tar.gz",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b10621/llama-b10621-bin-macos-arm64.tar.gz",
      sha256:
        "429c8270608600188035e5e92f7d78dffb7900904fe7dd7e6a84f48068cd13cf",
      expectedBytes: 10_954_823,
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

module.exports = {
  SPEED_LLAMA_RUNTIME_CUDA12,
  SPEED_LLAMA_RUNTIME_CUDA13,
  SPEED_LLAMA_RUNTIME_METAL_ARM64,
  SPEED_LLAMA_RUNTIME_VULKAN,
};
