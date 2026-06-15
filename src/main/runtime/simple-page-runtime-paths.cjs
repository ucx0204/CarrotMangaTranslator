const { existsSync, readdirSync } = require("node:fs");
const path = require("node:path");

const {
  bundledServerCandidates,
  resolveBundledServerPath,
} = require("./resolve-llama-runtime.cjs");
const {
  BEELLAMA_LLAMA_RUNTIME_CUDA12,
  BEELLAMA_LLAMA_RUNTIME_CUDA13,
  MAINLINE_LLAMA_RUNTIME_CUDA12,
  MAINLINE_LLAMA_RUNTIME_CUDA13,
  MAINLINE_LLAMA_RUNTIME_VULKAN,
  resolveLemonadeLlamaRuntimeRocm,
} = require("./simple-page-llama-runtimes.cjs");
const {
  resolveAmdRocmTargetFromOptions,
} = require("./simple-page-amd-rocm-target.cjs");
const {
  resolveConfiguredLocalModelPath,
  resolveConfiguredModelFile,
  resolveConfiguredModelRepo,
  resolveConfiguredMmprojFile,
  resolveConfiguredMmprojRepo,
} = require("./simple-page-model-config.cjs");
const {
  isLikelyPackagedToolsDir,
  runtimeOverrideEnv,
} = require("./simple-page-child-env.cjs");
const { resolveWorkingDir } = require("./simple-page-cache-paths.cjs");

function createDetailedError(message, detail = {}, cause) {
  const error = new Error(message);
  if (cause !== undefined) {
    error.cause = cause;
  }
  Object.assign(error, detail);
  return error;
}

function resolveToolsDir(options = {}) {
  const candidates = [
    options.toolsDir,
    runtimeOverrideEnv("MANGA_TRANSLATOR_TOOLS_DIR", options),
    path.resolve(__dirname, "..", "tools"),
    path.resolve(__dirname, "..", "..", "tools"),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

function resolveManagedToolsDir(options = {}) {
  const explicit = String(
    options.managedToolsDir ??
      runtimeOverrideEnv("MANGA_TRANSLATOR_MANAGED_TOOLS_DIR", options) ??
      "",
  ).trim();
  if (explicit) {
    return explicit;
  }
  return path.join(resolveWorkingDir(options), "tools");
}

function resolveLlamaRuntimeSearchDirs(options = {}) {
  const dirs = [resolveManagedToolsDir(options), resolveToolsDir(options)];
  const seen = new Set();
  return dirs.filter((dir) => {
    if (!dir) {
      return false;
    }
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function serverBinaryName() {
  return process.platform === "win32" ? "llama-server.exe" : "llama-server";
}

function hasCudaRuntimeBackend(runtimeDir) {
  try {
    return ["ggml-cuda.dll", "ggml-cuda-cu12.dll", "ggml-cuda-cu13.dll"].some(
      (fileName) => existsSync(path.join(runtimeDir, fileName)),
    );
  } catch {
    return false;
  }
}

function hasLlamaRuntimeBackend(runtimeDir, backend = "cuda") {
  const normalized = String(backend || "cuda")
    .trim()
    .toLowerCase();
  try {
    if (normalized === "vulkan") {
      return ["ggml-vulkan.dll", "libggml-vulkan.so"].some((fileName) =>
        existsSync(path.join(runtimeDir, fileName)),
      );
    }
    if (normalized === "rocm" || normalized === "hip") {
      return [
        "ggml-hip.dll",
        "ggml-rocm.dll",
        "libggml-hip.so",
        "libggml-rocm.so",
      ].some((fileName) => existsSync(path.join(runtimeDir, fileName)));
    }
    return hasCudaRuntimeBackend(runtimeDir);
  } catch {
    return false;
  }
}

function hasAnyRuntimeLibraryFile(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).some(
      (entry) => entry.isFile() && /\.(?:dat|co|hsaco)$/i.test(entry.name),
    );
  } catch {
    return false;
  }
}

function missingRocmRuntimeLibraryDirs(runtimeDir) {
  const missing = [];
  const rocblasLibraryDir = path.join(runtimeDir, "rocblas", "library");
  const hipblasltLibraryDir = path.join(runtimeDir, "hipblaslt", "library");
  if (!hasAnyRuntimeLibraryFile(rocblasLibraryDir)) {
    missing.push("rocblas/library/*.dat|*.co|*.hsaco");
  }
  if (!hasAnyRuntimeLibraryFile(hipblasltLibraryDir)) {
    missing.push("hipblaslt/library/*.dat|*.co|*.hsaco");
  }
  return missing;
}

function hasRequiredLlamaRuntimeFiles(runtimeDir, runtime) {
  if (!runtimeDir || !runtime) {
    return false;
  }
  try {
    for (const requirement of runtime.requiredFiles || [serverBinaryName()]) {
      const candidates = Array.isArray(requirement)
        ? requirement
        : [requirement];
      if (
        !candidates.some((fileName) =>
          existsSync(path.join(runtimeDir, fileName)),
        )
      ) {
        return false;
      }
    }
    const backend = String(runtime.backend || "cuda").toLowerCase();
    if (
      (backend === "rocm" || backend === "hip") &&
      missingRocmRuntimeLibraryDirs(runtimeDir).length > 0
    ) {
      return false;
    }
    return hasLlamaRuntimeBackend(runtimeDir, runtime.backend);
  } catch {
    return false;
  }
}

function missingRequiredLlamaRuntimeFiles(runtimeDir, runtime) {
  const missing = [];
  for (const requirement of runtime?.requiredFiles || [serverBinaryName()]) {
    const candidates = Array.isArray(requirement) ? requirement : [requirement];
    if (
      !candidates.some((fileName) =>
        existsSync(path.join(runtimeDir, fileName)),
      )
    ) {
      missing.push(candidates.join(" | "));
    }
  }
  if (!hasLlamaRuntimeBackend(runtimeDir, runtime?.backend)) {
    const backend = String(runtime?.backend || "cuda").toLowerCase();
    if (backend === "vulkan") {
      missing.push("ggml-vulkan.dll | libggml-vulkan.so");
    } else if (backend === "rocm" || backend === "hip") {
      missing.push(
        "ggml-hip.dll | ggml-rocm.dll | libggml-hip.so | libggml-rocm.so",
      );
    } else {
      missing.push("ggml-cuda.dll | ggml-cuda-cu12.dll | ggml-cuda-cu13.dll");
    }
  }
  const backend = String(runtime?.backend || "cuda").toLowerCase();
  if (backend === "rocm" || backend === "hip") {
    missing.push(...missingRocmRuntimeLibraryDirs(runtimeDir));
  }
  return missing;
}

function isRuntimeCandidate(serverPath, runtime) {
  try {
    const runtimeDir = path.dirname(serverPath);
    return (
      path.basename(runtimeDir).toLowerCase() === runtime.dir.toLowerCase() &&
      hasRequiredLlamaRuntimeFiles(runtimeDir, runtime)
    );
  } catch {
    return false;
  }
}

function shouldUseRtx50LlamaRuntime(options = {}) {
  const profile = String(
    options.llamaRuntimeProfile ??
      runtimeOverrideEnv("MANGA_TRANSLATOR_LLAMA_RUNTIME_PROFILE", options) ??
      "",
  )
    .trim()
    .toLowerCase();
  if (
    ["rtx50", "blackwell", "cuda13", "cuda13.1", "cuda13.3"].includes(profile)
  ) {
    return true;
  }
  if (["default", "cuda12", "cuda12.4", "legacy"].includes(profile)) {
    return false;
  }
  const cudaTag = String(
    options.ocrGpuCudaTag ??
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG", options) ??
      "",
  )
    .trim()
    .toLowerCase();
  return (
    cudaTag === "cu129" ||
    cudaTag === "cu13" ||
    cudaTag === "cu131" ||
    cudaTag === "cu133"
  );
}

function resolveLlamaRuntimeProfile(options = {}) {
  const profile = String(
    options.llamaRuntimeProfile ??
      runtimeOverrideEnv("MANGA_TRANSLATOR_LLAMA_RUNTIME_PROFILE", options) ??
      "",
  )
    .trim()
    .toLowerCase();
  if (["rocm", "hip", "amd-rocm"].includes(profile)) {
    return "rocm";
  }
  if (["vulkan", "vk", "amd-vulkan"].includes(profile)) {
    return "vulkan";
  }
  if (
    ["rtx50", "blackwell", "cuda13", "cuda13.1", "cuda13.3"].includes(profile)
  ) {
    return "rtx50";
  }
  return "cuda12";
}

function isGemma26BModel(options = {}) {
  const parts = [
    resolveConfiguredModelRepo(options),
    resolveConfiguredModelFile(options),
    resolveConfiguredLocalModelPath(options),
    resolveConfiguredMmprojRepo(options),
    resolveConfiguredMmprojFile(options),
  ];
  return parts.some((part) => /gemma[-_]?4[-_]?26b/i.test(String(part || "")));
}

function isGemma12BModel(options = {}) {
  const parts = [
    resolveConfiguredModelRepo(options),
    resolveConfiguredModelFile(options),
    resolveConfiguredLocalModelPath(options),
    resolveConfiguredMmprojRepo(options),
    resolveConfiguredMmprojFile(options),
  ];
  return parts.some((part) => /gemma[-_]?4[-_]?12b/i.test(String(part || "")));
}

function isGemma31BModel(options = {}) {
  const parts = [
    resolveConfiguredModelRepo(options),
    resolveConfiguredModelFile(options),
    resolveConfiguredLocalModelPath(options),
    resolveConfiguredMmprojRepo(options),
    resolveConfiguredMmprojFile(options),
  ];
  return parts.some((part) => /gemma[-_]?4[-_]?31b/i.test(String(part || "")));
}

function isMainlineGemmaModel(options = {}) {
  return isGemma12BModel(options) || isGemma26BModel(options);
}

function isBuiltInGemmaRuntimeModel(options = {}) {
  return isMainlineGemmaModel(options) || isGemma31BModel(options);
}

function resolvePreferredLlamaRuntime(options = {}) {
  const profile = resolveLlamaRuntimeProfile(options);
  if (profile === "rocm") {
    const rocmTarget = resolveAmdRocmTargetFromOptions(options);
    if (!rocmTarget) {
      throw createDetailedError(
        "AMD GPU 아키텍처를 확인하지 못해 ROCm llama 런타임을 선택할 수 없습니다.",
        {
          llamaRuntimeProfile: "rocm",
          hint: "AMD GPU 이름/ROCm gfx 아키텍처를 감지하지 못했습니다. 설정을 Vulkan으로 바꾸거나 MANGA_TRANSLATOR_AMD_ROCM_TARGET=gfx103X/gfx110X/gfx1150/gfx1151/gfx120X 중 하나로 지정하세요.",
        },
      );
    }
    return resolveLemonadeLlamaRuntimeRocm(rocmTarget);
  }
  if (profile === "vulkan") {
    return MAINLINE_LLAMA_RUNTIME_VULKAN;
  }
  const rtx50Runtime = shouldUseRtx50LlamaRuntime(options);
  if (isMainlineGemmaModel(options)) {
    return rtx50Runtime
      ? MAINLINE_LLAMA_RUNTIME_CUDA13
      : MAINLINE_LLAMA_RUNTIME_CUDA12;
  }
  return rtx50Runtime
    ? BEELLAMA_LLAMA_RUNTIME_CUDA13
    : BEELLAMA_LLAMA_RUNTIME_CUDA12;
}

function defaultServerPath(options = {}) {
  const dirs = resolveLlamaRuntimeSearchDirs(options);
  const existingCandidates = dirs.flatMap((dir) =>
    bundledServerCandidates(dir).filter((candidate) => existsSync(candidate)),
  );
  const preferredRuntime = resolvePreferredLlamaRuntime(options);
  const preferredCandidate = existingCandidates.find((candidate) =>
    isRuntimeCandidate(candidate, preferredRuntime),
  );
  if (preferredCandidate) {
    return preferredCandidate;
  }
  const preferredManagedPath = path.join(
    resolveManagedToolsDir(options),
    preferredRuntime.dir,
    serverBinaryName(),
  );
  if (isBuiltInGemmaRuntimeModel(options)) {
    return preferredManagedPath;
  }
  if (!existsSync(preferredManagedPath)) {
    return preferredManagedPath;
  }
  return (
    existingCandidates.find((candidate) =>
      hasLlamaRuntimeBackend(path.dirname(candidate), preferredRuntime.backend),
    ) ||
    existingCandidates.find((candidate) =>
      hasCudaRuntimeBackend(path.dirname(candidate)),
    ) ||
    existingCandidates[0] ||
    resolveBundledServerPath(dirs[0] || resolveToolsDir(options))
  );
}

function bundledFfmpegCandidates(toolsDir) {
  const binaryName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  return [
    path.join(toolsDir || "", "ffmpeg", binaryName),
    path.join(toolsDir || "", "ffmpeg", "bin", binaryName),
    path.join(toolsDir || "", binaryName),
  ];
}

function resolveFfmpegPath(options = {}) {
  const toolsDir = resolveToolsDir(options);
  const bundledCandidates = bundledFfmpegCandidates(toolsDir);
  const bundledPath = bundledCandidates.find((candidate) =>
    existsSync(candidate),
  );
  if (bundledPath) {
    return bundledPath;
  }

  if (isLikelyPackagedToolsDir(toolsDir)) {
    throw createDetailedError(
      "Bundled ffmpeg is missing from the packaged tools directory.",
      {
        toolsDir,
        candidatePaths: bundledCandidates,
        command: "ffmpeg",
      },
    );
  }

  const explicitCandidates = [
    options.ffmpegPath,
    runtimeOverrideEnv("MANGA_TRANSLATOR_FFMPEG_PATH", options),
  ].filter(Boolean);
  const explicitPath = explicitCandidates.find((candidate) =>
    existsSync(candidate),
  );
  if (explicitPath) {
    return explicitPath;
  }

  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

module.exports = {
  defaultServerPath,
  hasCudaRuntimeBackend,
  hasLlamaRuntimeBackend,
  hasRequiredLlamaRuntimeFiles,
  isBuiltInGemmaRuntimeModel,
  isGemma12BModel,
  isGemma26BModel,
  isGemma31BModel,
  isMainlineGemmaModel,
  isRuntimeCandidate,
  missingRequiredLlamaRuntimeFiles,
  resolveFfmpegPath,
  resolveLlamaRuntimeSearchDirs,
  resolveManagedToolsDir,
  resolvePreferredLlamaRuntime,
  resolveToolsDir,
  serverBinaryName,
  shouldUseRtx50LlamaRuntime,
};
