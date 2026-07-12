// @ts-check
const {
  BEELLAMA_LLAMA_RUNTIME_CUDA12,
  BEELLAMA_LLAMA_RUNTIME_CUDA13,
  BEELLAMA_LLAMA_RUNTIME_HIP_RADEON,
  MAINLINE_LLAMA_RUNTIME_CUDA12,
  MAINLINE_LLAMA_RUNTIME_CUDA13,
  MAINLINE_LLAMA_RUNTIME_VULKAN,
  resolveLemonadeLlamaRuntimeRocm,
} = require("../simple-page-llama-runtimes.cjs");
const {
  resolveAmdRocmTargetFromOptions,
} = require("../simple-page-amd-rocm-target.cjs");
const {
  resolveConfiguredLocalMmprojPath,
  resolveConfiguredLocalModelPath,
  resolveConfiguredModelFile,
  resolveConfiguredModelRepo,
  resolveConfiguredModelSource,
} = require("../simple-page-model-config.cjs");
const { runtimeOverrideEnv } = require("../simple-page-child-env.cjs");
const { createDetailedError } = require("../simple-page-runtime-common.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { llamaRuntimeProfile?: string | null }} RuntimePathOptions */

/** @param {RuntimePathOptions} [options] */
function normalizedConfiguredProfile(options = {}) {
  return String(
    options.llamaRuntimeProfile ??
      runtimeOverrideEnv("MANGA_TRANSLATOR_LLAMA_RUNTIME_PROFILE", options) ??
      "",
  )
    .trim()
    .toLowerCase();
}

/** @param {RuntimePathOptions} [options] */
function shouldUseRtx50LlamaRuntime(options = {}) {
  const profile = normalizedConfiguredProfile(options);
  if (
    ["rtx50", "blackwell", "cuda13", "cuda13.1", "cuda13.3"].includes(profile)
  )
    return true;
  if (["default", "cuda12", "cuda12.4", "legacy"].includes(profile))
    return false;
  const cudaTag = String(
    options.ocrGpuCudaTag ??
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG", options) ??
      "",
  )
    .trim()
    .toLowerCase();
  return ["cu129", "cu13", "cu131", "cu133"].includes(cudaTag);
}

/** @param {RuntimePathOptions} [options] */
function resolveLlamaRuntimeProfile(options = {}) {
  const profile = normalizedConfiguredProfile(options);
  if (["rocm", "hip", "amd-rocm"].includes(profile)) return "rocm";
  if (["vulkan", "vk", "amd-vulkan"].includes(profile)) return "vulkan";
  return ["rtx50", "blackwell", "cuda13", "cuda13.1", "cuda13.3"].includes(
    profile,
  )
    ? "rtx50"
    : "cuda12";
}

/** @param {RuntimePathOptions} [options] */
function configuredGemmaModelParts(options = {}) {
  if (resolveConfiguredModelSource(options) === "local") {
    return [
      resolveConfiguredLocalModelPath(options),
      resolveConfiguredLocalMmprojPath(options),
    ];
  }
  return [
    resolveConfiguredModelRepo(options),
    resolveConfiguredModelFile(options),
  ];
}

/** @param {RuntimePathOptions} options @param {RegExp} pattern */
function modelMatches(options, pattern) {
  return configuredGemmaModelParts(options).some((part) =>
    pattern.test(String(part || "")),
  );
}

/** @param {RuntimePathOptions} [options] */
function isGemma26BModel(options = {}) {
  return modelMatches(options, /gemma[-_]?4[-_]?26b/i);
}

/** @param {RuntimePathOptions} [options] */
function isGemma12BModel(options = {}) {
  return modelMatches(options, /gemma[-_]?4[-_]?12b/i);
}

/** @param {RuntimePathOptions} [options] */
function isGemma31BModel(options = {}) {
  return modelMatches(options, /gemma[-_]?4[-_]?31b/i);
}

/** @param {RuntimePathOptions} [options] */
function isMainlineGemmaModel(options = {}) {
  return isGemma12BModel(options) || isGemma26BModel(options);
}

/** @param {RuntimePathOptions} [options] */
function isBuiltInGemmaRuntimeModel(options = {}) {
  return isMainlineGemmaModel(options) || isGemma31BModel(options);
}

/** @param {RuntimePathOptions} options */
function resolveRocmRuntime(options) {
  if (isGemma31BModel(options)) return BEELLAMA_LLAMA_RUNTIME_HIP_RADEON;
  const rocmTarget = resolveAmdRocmTargetFromOptions(options);
  if (rocmTarget) return resolveLemonadeLlamaRuntimeRocm(rocmTarget);
  throw createDetailedError(
    "AMD GPU 아키텍처를 확인하지 못해 ROCm llama 런타임을 선택할 수 없습니다.",
    {
      llamaRuntimeProfile: "rocm",
      hint: "AMD GPU 이름/ROCm gfx 아키텍처를 감지하지 못했습니다. 설정을 Vulkan으로 바꾸거나 MANGA_TRANSLATOR_AMD_ROCM_TARGET=gfx103X/gfx110X/gfx1150/gfx1151/gfx120X 중 하나로 지정하세요.",
    },
  );
}

/** @param {RuntimePathOptions} [options] */
function resolvePreferredLlamaRuntime(options = {}) {
  const profile = resolveLlamaRuntimeProfile(options);
  if (profile === "rocm") return resolveRocmRuntime(options);
  if (profile === "vulkan") return MAINLINE_LLAMA_RUNTIME_VULKAN;
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

module.exports = {
  isBuiltInGemmaRuntimeModel,
  isGemma12BModel,
  isGemma26BModel,
  isGemma31BModel,
  isMainlineGemmaModel,
  resolvePreferredLlamaRuntime,
  shouldUseRtx50LlamaRuntime,
};
