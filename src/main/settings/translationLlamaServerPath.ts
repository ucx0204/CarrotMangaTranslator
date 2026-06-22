import { join } from "node:path";
import type { AppSettings } from "../../shared/settingsTypes";
import { normalizeAmdRocmTarget } from "../gpuInfo";
import type { TranslationOptionPaths } from "./appSettingsTypes";
import { isBuiltInGemmaModel, isMainlineGemmaModel } from "./gemmaModelPresets";
import {
  isRocmLlamaRuntimeProfile,
  isRtx50LlamaRuntimeProfile,
  isVulkanLlamaRuntimeProfile,
} from "./llamaRuntimeProfile";

const BEELLAMA_LLAMA_RUNTIME_DIR_CUDA12 = "beellama-v0.2.0-cuda12.4";
const BEELLAMA_LLAMA_RUNTIME_DIR_CUDA13 = "beellama-v0.2.0-cuda13.1";
const MAINLINE_LLAMA_RUNTIME_DIR_CUDA12 = "llama-b9547-cuda12.4";
const MAINLINE_LLAMA_RUNTIME_DIR_CUDA13 = "llama-b9547-cuda13.3";
const LEMONADE_LLAMA_RUNTIME_ROCM_RELEASE = "b1291";
const MAINLINE_LLAMA_RUNTIME_DIR_VULKAN = "llama-b9547-vulkan";

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
    return resolveRocmLlamaServerPath(paths, binaryName, llamaRocmTarget);
  }
  if (isVulkanLlamaRuntimeProfile(llamaRuntimeProfile)) {
    return join(
      paths.dataRoot,
      "tools",
      MAINLINE_LLAMA_RUNTIME_DIR_VULKAN,
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
  llamaRocmTarget?: string,
): string {
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
