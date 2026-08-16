// @ts-check
const {
  BEELLAMA_HIP_RADEON_ARCHIVE_CONTRACT,
} = require("./model/llama-runtime-archive-policy.cjs");
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
      sha256:
        "f05bdda225aa25123c9d57c7cb14ab5dcdfa730f756332bed765466a50c920b6",
      expectedBytes: 261_158_499,
    },
    {
      archive: "cudart-llama-bin-win-cuda-12.4-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b9547/cudart-llama-bin-win-cuda-12.4-x64.zip",
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
      sha256:
        "3fe964551526139b16c205d05948036e3cf621b974bb47744065e3d7bda93362",
      expectedBytes: 159_097_564,
    },
    {
      archive: "cudart-llama-bin-win-cuda-13.3-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b9547/cudart-llama-bin-win-cuda-13.3-x64.zip",
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

const LEMONADE_LLAMA_ROCM_RELEASE = "b1291";
const LEMONADE_LLAMA_ROCM_BASE_URL = `https://github.com/lemonade-sdk/llamacpp-rocm/releases/download/${LEMONADE_LLAMA_ROCM_RELEASE}`;
/** @type {Readonly<Record<string, string>>} */
const LEMONADE_LLAMA_ROCM_SHA256 = Object.freeze({
  gfx103X: "3692a765ca0d5616284cbfe71c0a8a925824a538e9fe0efeb8710620612ecf77",
  gfx110X: "bcdec2f3e256162b8a52abb10a39969329deaa2fc57e33ded938a1e761d57b20",
  gfx1150: "09a6fe572e2be24e3e87654355db84f6fc79a057eb60427a2aad1f388f9dc5a8",
  gfx1151: "f185c81c0eeab19f83e24a5a98576d6c2994d746d34f465d6582efe4547edb02",
  gfx120X: "51072424c83349ac375b574f432bf80d14a2c7920946128de2c526cfdc3012f1",
  gfx908: "3634008a78f75bafc27c211b374ad62b6eaec5dd2f79a354add5b8aec7eb71ae",
  gfx90a: "23746b7593158e9796d18f2d13448b318b8937710c3ed1447740db6193ab36e7",
});

/** @type {Readonly<Record<string, number>>} */
const LEMONADE_LLAMA_ROCM_BYTES = Object.freeze({
  gfx103X: 160_723_690,
  gfx110X: 201_186_573,
  gfx1150: 120_027_841,
  gfx1151: 125_399_764,
  gfx120X: 528_745_915,
  gfx908: 123_928_182,
  gfx90a: 242_111_030,
});

// Immutable central-directory audit of the pinned Windows runtime archives.
// These are selected output paths after the same flatten/preserve rules used
// by shouldExtractLlamaRuntimeFile. Keeping the exact maxima here lets the
// managed-tools resolver choose a short root before downloading gigabytes.
/** @type {Readonly<Record<string, number>>} */
const WINDOWS_LLAMA_RUNTIME_MAX_RELATIVE_PATH_LENGTH = Object.freeze({
  "beellama-v0.2.0-cuda12.4": 17,
  "beellama-v0.2.0-cuda13.1": 17,
  "beellama-v0.3.1-hip-radeon": 127,
  "llama-b9547-cuda12.4": 28,
  "llama-b9547-cuda13.3": 28,
  "llama-b9547-vulkan": 28,
  "lemonade-llama-b1291-rocm-gfx103X": 130,
  "lemonade-llama-b1291-rocm-gfx110X": 115,
  "lemonade-llama-b1291-rocm-gfx1150": 123,
  "lemonade-llama-b1291-rocm-gfx1151": 123,
  "lemonade-llama-b1291-rocm-gfx120X": 127,
  "lemonade-llama-b1291-rocm-gfx908": 122,
  "lemonade-llama-b1291-rocm-gfx90a": 137,
});

/**
 * @param {string} target
 */
function createLemonadeLlamaRuntimeRocm(target) {
  const archive = `llama-${LEMONADE_LLAMA_ROCM_RELEASE}-windows-rocm-${target}-x64.zip`;
  const sha256 = LEMONADE_LLAMA_ROCM_SHA256[target];
  const expectedBytes = LEMONADE_LLAMA_ROCM_BYTES[target];
  if (!sha256 || !expectedBytes) {
    throw new Error(
      `No pinned llama ROCm runtime exists for target: ${target}`,
    );
  }
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
        sha256,
        expectedBytes,
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
  resolveLemonadeLlamaRuntimeRocm,
  resolveWindowsLlamaRuntimeMaxRelativePathLength,
  shouldExtractLlamaRuntimeFile,
};
