// @ts-check
const {
  BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT,
} = require("./model/llama-runtime-archive-policy.cjs");
const {
  SPEED_LLAMA_RUNTIME_CUDA12,
  SPEED_LLAMA_RUNTIME_CUDA13,
  SPEED_LLAMA_RUNTIME_METAL_ARM64,
  SPEED_LLAMA_RUNTIME_VULKAN,
} = require("./model/speed-llama-runtime-contracts.cjs");
const {
  resolveLemonadeLlamaRuntimeRocm,
  resolveSpeedLemonadeLlamaRuntimeRocm,
} = require("./model/lemonade-llama-runtime-contracts.cjs");
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
      sha256:
        "e6fcbd650975b5634cceb33aedcec7693117ea55feae50330f5f2c83725bdaef",
      expectedBytes: 582_197_990,
    },
    {
      archive: "cudart-llama-bin-win-cuda-12.4-x64.zip",
      url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.2.0/cudart-llama-bin-win-cuda-12.4-x64.zip",
      sha256:
        "b7c63d27aad42645fb7228b66a60b13805277b56a3db876157996718132115d0",
      expectedBytes: 396_872_488,
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
      sha256:
        "7d23a41d34cd3fb01219189a298de60c152bfec5e2bfeee1b06f6aa059036a4e",
      expectedBytes: 287_720_926,
    },
    {
      archive: "cudart-llama-bin-win-cuda-13.1-x64.zip",
      url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.2.0/cudart-llama-bin-win-cuda-13.1-x64.zip",
      sha256:
        "01163b5ba513d7a410932d31477e22e496699a51c5902b3e21b32bd0241dff22",
      expectedBytes: 403_486_786,
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
  id: BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT.runtimeId,
  kind: BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT.runtimeKind,
  backend: BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT.backend,
  dir: "beellama-v0.3.1-hip-radeon",
  archive: BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT.archive,
  url: BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT.url,
  archives: [
    {
      archive: BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT.archive,
      url: BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT.url,
      sha256: BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT.sha256,
      expectedBytes: BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT.bytes,
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
  id: "llama-b9553-cuda12.4",
  kind: "mainline",
  backend: "cuda",
  dir: "llama-b9553-cuda12.4",
  archive: "llama-b9553-bin-win-cuda-12.4-x64.zip",
  url: "https://github.com/ggml-org/llama.cpp/releases/download/b9553/llama-b9553-bin-win-cuda-12.4-x64.zip",
  archives: [
    {
      archive: "llama-b9553-bin-win-cuda-12.4-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b9553/llama-b9553-bin-win-cuda-12.4-x64.zip",
      sha256:
        "c4267c20e592d7470b37ca15c6b6f69173a92fe2aeba12f80031b0198013ac3a",
      expectedBytes: 261_168_405,
    },
    {
      archive: "cudart-llama-bin-win-cuda-12.4-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b9553/cudart-llama-bin-win-cuda-12.4-x64.zip",
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

const MAINLINE_LLAMA_RUNTIME_CUDA13 = {
  id: "llama-b9553-cuda13.3",
  kind: "mainline",
  backend: "cuda",
  dir: "llama-b9553-cuda13.3",
  archive: "llama-b9553-bin-win-cuda-13.3-x64.zip",
  url: "https://github.com/ggml-org/llama.cpp/releases/download/b9553/llama-b9553-bin-win-cuda-13.3-x64.zip",
  archives: [
    {
      archive: "llama-b9553-bin-win-cuda-13.3-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b9553/llama-b9553-bin-win-cuda-13.3-x64.zip",
      sha256:
        "d6f0d9df5c56748551c9498ed9620a90f022cd6b8073810c43ce224567955632",
      expectedBytes: 159_107_470,
    },
    {
      archive: "cudart-llama-bin-win-cuda-13.3-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b9553/cudart-llama-bin-win-cuda-13.3-x64.zip",
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
      sha256:
        "12c8f21b1974fdbaa53c72ce67d2c5665e5908d836501e4c988d4bf0281fee64",
      expectedBytes: 33_920_738,
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
      expectedBytes: 10_519_888,
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
      expectedBytes: 11_109_738,
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

// Immutable central-directory audit of the pinned Windows runtime archives.
// These are selected output paths after the same flatten/preserve rules used
// by shouldExtractLlamaRuntimeFile. Keeping the exact maxima here lets the
// managed-tools resolver choose a short root before downloading gigabytes.
/** @type {Readonly<Record<string, number>>} */
const WINDOWS_LLAMA_RUNTIME_MAX_RELATIVE_PATH_LENGTH = Object.freeze({
  "beellama-v0.2.0-cuda12.4": 17,
  "beellama-v0.2.0-cuda13.1": 17,
  "beellama-v0.3.1-hip-radeon": 127,
  "llama-b9553-cuda12.4": 28,
  "llama-b9553-cuda13.3": 28,
  "llama-b9547-vulkan": 28,
  "llama-b10621-cuda12.4": 28,
  "llama-b10621-cuda13.3": 28,
  "llama-b10621-vulkan": 28,
  "lemonade-llama-b1291-rocm-gfx103X": 130,
  "lemonade-llama-b1291-rocm-gfx110X": 115,
  "lemonade-llama-b1291-rocm-gfx1150": 123,
  "lemonade-llama-b1291-rocm-gfx1151": 123,
  "lemonade-llama-b1291-rocm-gfx120X": 127,
  "lemonade-llama-b1291-rocm-gfx908": 122,
  "lemonade-llama-b1291-rocm-gfx90a": 137,
  "lemonade-llama-b1317-rocm-gfx103X": 102,
  "lemonade-llama-b1317-rocm-gfx110X": 122,
  "lemonade-llama-b1317-rocm-gfx1150": 122,
  "lemonade-llama-b1317-rocm-gfx1151": 122,
  "lemonade-llama-b1317-rocm-gfx120X": 134,
  "lemonade-llama-b1317-rocm-gfx908": 121,
  "lemonade-llama-b1317-rocm-gfx90a": 137,
  "lemonade-llama-b1316-rocm-gfx103X": 102,
  "lemonade-llama-b1316-rocm-gfx110X": 128,
  "lemonade-llama-b1316-rocm-gfx1150": 128,
  "lemonade-llama-b1316-rocm-gfx1151": 128,
  "lemonade-llama-b1316-rocm-gfx120X": 140,
  "lemonade-llama-b1316-rocm-gfx908": 127,
  "lemonade-llama-b1316-rocm-gfx90a": 137,
});

const LLAMA_RUNTIME_MARKER_FILE = ".mgt-runtime.json";
const LLAMA_RUNTIME_FILES = new Set([
  "LICENSE",
  "llama-cli",
  "llama-server",
  "llama-server.exe",
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

/** @param {{ id?: unknown; requiredFiles?: Array<string | string[]> } | null | undefined} runtime */
function resolveWindowsLlamaRuntimeMaxRelativePathLength(runtime) {
  const pinnedMaximum =
    WINDOWS_LLAMA_RUNTIME_MAX_RELATIVE_PATH_LENGTH[String(runtime?.id || "")];
  if (pinnedMaximum) return pinnedMaximum;
  const requiredFiles = Array.isArray(runtime?.requiredFiles)
    ? runtime.requiredFiles.flatMap((entry) =>
        Array.isArray(entry) ? entry : [entry],
      )
    : [];
  return Math.max(
    255,
    LLAMA_RUNTIME_MARKER_FILE.length,
    ...requiredFiles.map((fileName) => String(fileName).length),
  );
}

module.exports = {
  BEELLAMA_LLAMA_RUNTIME_CUDA12,
  BEELLAMA_LLAMA_RUNTIME_CUDA13,
  BEELLAMA_LLAMA_RUNTIME_HIP_RADEON,
  BEELLAMA_LLAMA_RUNTIME_METAL_ARM64,
  LLAMA_RUNTIME_MARKER_FILE,
  MAINLINE_LLAMA_RUNTIME_CUDA12,
  MAINLINE_LLAMA_RUNTIME_CUDA13,
  MAINLINE_LLAMA_RUNTIME_VULKAN,
  MAINLINE_LLAMA_RUNTIME_METAL_ARM64,
  SPEED_LLAMA_RUNTIME_CUDA12,
  SPEED_LLAMA_RUNTIME_CUDA13,
  SPEED_LLAMA_RUNTIME_VULKAN,
  SPEED_LLAMA_RUNTIME_METAL_ARM64,
  resolveLemonadeLlamaRuntimeRocm,
  resolveSpeedLemonadeLlamaRuntimeRocm,
  resolveWindowsLlamaRuntimeMaxRelativePathLength,
  shouldExtractLlamaRuntimeFile,
};
