import type { KoharuInpaintingBackend } from "../../shared/inpaintingSettingsTypes";
import {
  createCombinedDownloadProgress,
  ensureRemoteFile,
  hfResolveUrl,
} from "./fluxAssets";
import type { InpaintingRuntimeProgress } from "./inpaintingEngine";
import { ensureKoharuWorkerLaunch } from "./koharuAssets";
import type { KoharuWorkerLaunchSpec } from "./koharuWorkerTypes";

const BUBBLE_SEGMENTATION_MODEL_REPO = "mayocream/speech-bubble-segmentation";
const BUBBLE_SEGMENTATION_MODEL_REVISION =
  "387bc1e93f3d24702bc8609798b6a13b37420edc";
const BUBBLE_SEGMENTATION_CONFIG_FILE = "config.json";
const BUBBLE_SEGMENTATION_MODEL_FILE = "model.safetensors";
const BUBBLE_SEGMENTATION_CONFIG_SHA256 =
  "36bb5b9c58a9bfbd9eebcf3569d9019ebb67585d4b572bd3762f7ecc15ebd6b5";
const BUBBLE_SEGMENTATION_MODEL_SHA256 =
  "c881d96771755fa628a94bb5f4b18301a0728ae4ffe8f14b2e9dde55e1b40552";

export async function ensureBubbleSegmentationWorkerLaunch(options: {
  backend: Exclude<KoharuInpaintingBackend, "auto">;
  cudaRuntimeDir: string;
  modelDir: string;
  runtimeDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
}): Promise<KoharuWorkerLaunchSpec> {
  const download = createCombinedDownloadProgress(
    options.onProgress,
    "말풍선 정밀 감지 모델",
  );
  const [configPath, weightsPath] = await Promise.all([
    ensureRemoteFile({
      modelDir: options.modelDir,
      fileName: BUBBLE_SEGMENTATION_CONFIG_FILE,
      label: "Speech Bubble Segmentation config",
      url: hfResolveUrl(
        BUBBLE_SEGMENTATION_MODEL_REPO,
        BUBBLE_SEGMENTATION_CONFIG_FILE,
        BUBBLE_SEGMENTATION_MODEL_REVISION,
      ),
      expectedSha256: BUBBLE_SEGMENTATION_CONFIG_SHA256,
      minimumBytes: 100,
      signal: options.signal,
      onProgress: download.forFile(),
    }),
    ensureRemoteFile({
      modelDir: options.modelDir,
      fileName: BUBBLE_SEGMENTATION_MODEL_FILE,
      label: "Speech Bubble Segmentation",
      url: hfResolveUrl(
        BUBBLE_SEGMENTATION_MODEL_REPO,
        BUBBLE_SEGMENTATION_MODEL_FILE,
        BUBBLE_SEGMENTATION_MODEL_REVISION,
      ),
      expectedSha256: BUBBLE_SEGMENTATION_MODEL_SHA256,
      signal: options.signal,
      onProgress: download.forFile(),
    }),
  ]);

  return ensureKoharuWorkerLaunch({
    backend: options.backend,
    cudaRuntimeDir: options.cudaRuntimeDir,
    runtimeDir: options.runtimeDir,
    model: "speech-bubble-segmentation",
    modelFiles: {
      model: "speech-bubble-segmentation",
      configPath,
      weightsPath,
    },
    signal: options.signal,
    onProgress: options.onProgress,
  });
}
