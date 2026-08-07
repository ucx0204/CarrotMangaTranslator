import { mkdir } from "node:fs/promises";
import {
  FLUX_DIFFUSERS_MODEL_ID,
  FLUX_MODEL_FILE,
  FLUX_MODEL_REPO,
  FLUX_MODEL_REVISION,
  FLUX_MODEL_SHA256,
  FLUX_SDCPP_LLM_FILE,
  FLUX_SDCPP_LLM_REPO,
  FLUX_SDCPP_VAE_FILE,
  FLUX_VAE_REPO,
} from "./constants";
import type {
  FluxAssetProgress,
  FluxPythonBackend,
  FluxPythonRuntime,
} from "./types";
import {
  ensureRemoteFile,
  hfResolveUrl,
} from "../../runtimeSupport/modelDownloads";
import { resolveFluxPythonMode } from "./manifests";
import { MAX_REMOTE_SUPPORT_ASSET_BYTES } from "../../runtimeSupport/downloadBudgets";
import {
  buildFluxPythonHuggingFaceEnv,
  ensureFluxPythonModelCache,
} from "./pythonRuntimePackages";
import type { FluxWorkerLaunchSpec } from "../fluxWorkerTypes";

export async function buildFluxPythonLaunchSpec(options: {
  backend: FluxPythonBackend;
  modelDir: string;
  onProgress?: (progress: FluxAssetProgress) => void;
  pythonRuntime: FluxPythonRuntime;
  signal?: AbortSignal;
  workerPath: string;
}): Promise<FluxWorkerLaunchSpec> {
  await ensureModelDir(options);
  if (options.backend === "python-rocm") {
    return buildRocmFluxPythonLaunchSpec(options);
  }
  return buildCpuFluxPythonLaunchSpec(options);
}

async function ensureModelDir({
  modelDir,
}: {
  modelDir: string;
}): Promise<void> {
  await mkdir(modelDir, { recursive: true });
}

async function buildRocmFluxPythonLaunchSpec(options: {
  backend: FluxPythonBackend;
  modelDir: string;
  onProgress?: (progress: FluxAssetProgress) => void;
  pythonRuntime: FluxPythonRuntime;
  signal?: AbortSignal;
  workerPath: string;
}): Promise<FluxWorkerLaunchSpec> {
  const models = await ensureRocmFluxModels(options);
  options.onProgress?.({
    progressText: "Flux stable-diffusion.cpp 런타임 준비 완료",
    detail: "ROCm · GGUF Q4_K_M",
    progressMode: "log-only",
    installLogLine:
      "Flux stable-diffusion.cpp ROCm/HIP + GGUF 런타임을 사용합니다.",
  });
  return {
    backend: options.backend,
    executable: options.pythonRuntime.executable,
    runtimePath: options.pythonRuntime.executable,
    label: "Flux stable-diffusion.cpp ROCm",
    args: [
      ...options.pythonRuntime.args,
      "-u",
      options.workerPath,
      "--backend",
      "rocm",
      "--diffusion-model",
      models.diffusionModelPath,
      "--vae",
      models.vaePath,
      "--llm",
      models.llmPath,
    ],
    env: buildFluxPythonHuggingFaceEnv(
      options.pythonRuntime.env,
      options.modelDir,
    ),
  };
}

async function ensureRocmFluxModels({
  modelDir,
  onProgress,
  signal,
}: {
  modelDir: string;
  onProgress?: (progress: FluxAssetProgress) => void;
  signal?: AbortSignal;
}): Promise<{
  diffusionModelPath: string;
  llmPath: string;
  vaePath: string;
}> {
  const diffusionModelPath = await ensureRemoteFile({
    modelDir,
    fileName: FLUX_MODEL_FILE,
    label: "Flux Klein 4B GGUF",
    url: hfResolveUrl(FLUX_MODEL_REPO, FLUX_MODEL_FILE, FLUX_MODEL_REVISION),
    expectedSha256: FLUX_MODEL_SHA256,
    maximumBytes: MAX_REMOTE_SUPPORT_ASSET_BYTES,
    signal,
    onProgress,
  });
  const vaePath = await ensureRemoteFile({
    modelDir,
    fileName: FLUX_SDCPP_VAE_FILE,
    label: "Flux small decoder",
    url: hfResolveUrl(FLUX_VAE_REPO, FLUX_SDCPP_VAE_FILE),
    maximumBytes: MAX_REMOTE_SUPPORT_ASSET_BYTES,
    signal,
    onProgress,
  });
  const llmPath = await ensureRemoteFile({
    modelDir,
    fileName: FLUX_SDCPP_LLM_FILE,
    label: "Flux text encoder GGUF",
    url: hfResolveUrl(FLUX_SDCPP_LLM_REPO, FLUX_SDCPP_LLM_FILE),
    maximumBytes: MAX_REMOTE_SUPPORT_ASSET_BYTES,
    signal,
    onProgress,
  });
  return { diffusionModelPath, llmPath, vaePath };
}

async function buildCpuFluxPythonLaunchSpec(options: {
  backend: FluxPythonBackend;
  modelDir: string;
  onProgress?: (progress: FluxAssetProgress) => void;
  pythonRuntime: FluxPythonRuntime;
  signal?: AbortSignal;
  workerPath: string;
}): Promise<FluxWorkerLaunchSpec> {
  const modelId =
    process.env.MANGA_TRANSLATOR_FLUX_PYTHON_MODEL_ID ??
    process.env.MGT_FLUX_PYTHON_MODEL_ID ??
    FLUX_DIFFUSERS_MODEL_ID;
  const mode = resolveFluxPythonMode();
  await ensureFluxPythonModelCache({
    pythonRuntime: options.pythonRuntime,
    modelDir: options.modelDir,
    modelId,
    ignorePatterns: [],
    signal: options.signal,
    onProgress: options.onProgress,
  });
  options.onProgress?.({
    progressText: "Flux Python 런타임 준비 완료",
    detail: `CPU · ${modelId}`,
    progressMode: "log-only",
    installLogLine: "Flux Python CPU 런타임을 사용합니다.",
  });
  return {
    backend: options.backend,
    executable: options.pythonRuntime.executable,
    runtimePath: options.pythonRuntime.executable,
    label: "Flux Python CPU",
    args: [
      ...options.pythonRuntime.args,
      "-u",
      options.workerPath,
      "--backend",
      "cpu",
      "--model-id",
      modelId,
      "--mode",
      mode,
      "--cache-dir",
      options.modelDir,
    ],
    env: buildFluxPythonHuggingFaceEnv(
      options.pythonRuntime.env,
      options.modelDir,
    ),
  };
}
