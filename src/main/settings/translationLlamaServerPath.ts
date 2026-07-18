import { join } from "node:path";
import type { AppSettings } from "../../shared/settingsTypes";
import { normalizeAmdRocmTarget } from "../gpuInfo";
import type { TranslationOptionPaths } from "./appSettingsTypes";
import {
  is31BGemmaModel,
  isBuiltInGemmaModel,
  isMainlineGemmaModel,
} from "./gemmaModelPresets";
import {
  isRocmLlamaRuntimeProfile,
  isMetalLlamaRuntimeProfile,
  isRtx50LlamaRuntimeProfile,
  isVulkanLlamaRuntimeProfile,
} from "./llamaRuntimeProfile";

const BEELLAMA_LLAMA_RUNTIME_DIR_CUDA12 = "beellama-v0.2.0-cuda12.4";
const BEELLAMA_LLAMA_RUNTIME_DIR_CUDA13 = "beellama-v0.2.0-cuda13.1";
const BEELLAMA_LLAMA_RUNTIME_DIR_HIP_RADEON = "beellama-v0.3.1-hip-radeon";
const MAINLINE_LLAMA_RUNTIME_DIR_CUDA12 = "llama-b9547-cuda12.4";
const MAINLINE_LLAMA_RUNTIME_DIR_CUDA13 = "llama-b9547-cuda13.3";
const LEMONADE_LLAMA_RUNTIME_ROCM_RELEASE = "b1291";
const MAINLINE_LLAMA_RUNTIME_DIR_VULKAN = "llama-b9547-vulkan";
const MAINLINE_LLAMA_RUNTIME_DIR_METAL_ARM64 = "llama-b9547-metal-arm64";
const BEELLAMA_LLAMA_RUNTIME_DIR_METAL_ARM64 = "beellama-v0.3.1-metal-arm64";

export function resolveDefaultLlamaServerPathForGemma(
  paths: TranslationOptionPaths,
  gemma: AppSettings["gemma"],
  llamaRuntimeProfile = "cuda12",
  llamaRocmTarget?: string,
): string {
  if (!shouldUseBundledLlamaServer(gemma)) {
    return paths.llamaServerPath;
  }
  const binaryName =
    process.platform === "win32" ? "llama-server.exe" : "llama-server";
  if (isRocmLlamaRuntimeProfile(llamaRuntimeProfile)) {
    return resolveRocmLlamaServerPath(
      paths,
      binaryName,
      gemma,
      llamaRocmTarget,
    );
  }
  if (isVulkanLlamaRuntimeProfile(llamaRuntimeProfile)) {
    return join(
      paths.dataRoot,
      "tools",
      MAINLINE_LLAMA_RUNTIME_DIR_VULKAN,
      binaryName,
    );
  }
  if (isMetalLlamaRuntimeProfile(llamaRuntimeProfile)) {
    return join(
      paths.toolsDir,
      is31BGemmaModel(gemma)
        ? BEELLAMA_LLAMA_RUNTIME_DIR_METAL_ARM64
        : MAINLINE_LLAMA_RUNTIME_DIR_METAL_ARM64,
      binaryName,
    );
  }
  return join(
    paths.dataRoot,
    "tools",
    resolveCudaLlamaRuntimeDir(gemma, llamaRuntimeProfile),
    binaryName,
  );
}

function shouldUseBundledLlamaServer(gemma: AppSettings["gemma"]): boolean {
  return (
    gemma.modelSource === "huggingface" &&
    isBuiltInGemmaModel({
      modelRepo: gemma.modelRepo,
      modelFile: gemma.modelFile,
    })
  );
}

function resolveRocmLlamaServerPath(
  paths: TranslationOptionPaths,
  binaryName: string,
  gemma: AppSettings["gemma"],
  llamaRocmTarget?: string,
): string {
  if (is31BGemmaModel(gemma)) {
    return join(
      paths.dataRoot,
      "tools",
      BEELLAMA_LLAMA_RUNTIME_DIR_HIP_RADEON,
      binaryName,
    );
  }
  const rocmTarget = normalizeAmdRocmTarget(llamaRocmTarget) ?? "unknown";
  return join(
    paths.dataRoot,
    "tools",
    `lemonade-llama-${LEMONADE_LLAMA_RUNTIME_ROCM_RELEASE}-rocm-${rocmTarget}`,
    binaryName,
  );
}

function resolveCudaLlamaRuntimeDir(
  gemma: AppSettings["gemma"],
  llamaRuntimeProfile: string,
): string {
  const useCuda13 = isRtx50LlamaRuntimeProfile(llamaRuntimeProfile);
  if (isMainlineGemmaModel(gemma)) {
    return useCuda13
      ? MAINLINE_LLAMA_RUNTIME_DIR_CUDA13
      : MAINLINE_LLAMA_RUNTIME_DIR_CUDA12;
  }
  return useCuda13
    ? BEELLAMA_LLAMA_RUNTIME_DIR_CUDA13
    : BEELLAMA_LLAMA_RUNTIME_DIR_CUDA12;
}
