import { basename } from "node:path";
import {
  ensureRemoteFile,
  hfResolveUrl,
} from "../runtimeSupport/modelDownloads";
import { createCombinedDownloadProgress } from "./fluxAssets/progress";
import type { InpaintingRuntimeProgress } from "./inpaintingEngine";

const textRepo = "Qwen/Qwen3-VL-8B-Instruct-GGUF";
const textRevision = "f982a07559d4a2f6c8744d840bf6fccab30eea96";

const files = {
  diffusion: {
    repo: "leejet/Qwen-Image-2.1-GGUF",
    revision: "0bca76da6edd8a18211e9717454615c1bbaaf6ed",
    file: "qwen_image_2.1-Q8_0.gguf",
    bytes: 7_687_155_744,
    sha256: "f8b244b00937f0e444a40dbf7866460871b89b30142594973b6012d1b471dc0a",
  },
  text: {
    repo: textRepo,
    revision: textRevision,
    file: "Qwen3VL-8B-Instruct-Q4_K_M.gguf",
    bytes: 5_027_784_800,
    sha256: "67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2",
  },
  vision: {
    repo: textRepo,
    revision: textRevision,
    file: "mmproj-Qwen3VL-8B-Instruct-F16.gguf",
    bytes: 1_159_029_824,
    sha256: "ca524100ebf825c9a870db1c580d03879e0da0ab2541697e2458e64891cf9d38",
  },
  vae: {
    repo: "Comfy-Org/Qwen-Image-2.1",
    revision: "aacf31a6d48e707f352ecba714cee0680da3479b",
    file: "vae/qwen_image_2.1_vae_bf16.safetensors",
    bytes: 675_509_688,
    sha256: "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9",
  },
} as const;

export const qwenSubstrateAsset = {
  repo: "mayocream/lama-manga-onnx",
  revision: "b55497aadbfcb9740e1ed16f008268d71b4f3f79",
  file: "lama-manga.onnx",
  bytes: 207_482_644,
  sha256: "4512adab295ee5a5e02ccd1bdf8d45dccbac88309d9cff1532ffd5de876f02a4",
} as const;

const controlFiles = {
  control: {
    repo: files.vae.repo,
    revision: files.vae.revision,
    file: "model_patches/qwen_image_2.1_fun_controlnet_union_int8_convrot.safetensors",
    bytes: 3_779_298_944,
    sha256: "07aa961570ac0e03d4ca936aecd76854d077a33cde69b5092399afba01b3715d",
  },
  prior: qwenSubstrateAsset,
} as const;

export type QwenImageModelPaths = Record<keyof typeof files, string>;

type DownloadOptions = {
  modelDir: string;
  signal?: AbortSignal;
  onProgress?: (event: InpaintingRuntimeProgress) => void;
};

type ModelAsset = {
  repo: string;
  revision: string;
  file: string;
  bytes: number;
  sha256: string;
};

export function ensureQwenImageModels(options: DownloadOptions) {
  return downloadModels({ ...files, prior: controlFiles.prior }, options);
}

export function ensureQwenControlModels(options: DownloadOptions) {
  return downloadModels(
    {
      diffusion: files.diffusion,
      text: files.text,
      vae: files.vae,
      ...controlFiles,
    },
    options,
  );
}

export async function ensureQwenTurboModel(options: DownloadOptions) {
  const { turbo } = await downloadModels(
    {
      turbo: {
        repo: files.vae.repo,
        revision: files.vae.revision,
        file: "diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors",
        bytes: 7_256_787_829,
        sha256:
          "8144a0182964aa8403ad6dbc011db837304167d235161b9aabaa8532e967314c",
      },
    },
    options,
  );
  return turbo;
}

/** CPU-only printed-line verification of an already edited miniature jacket. */
export async function ensureQwenJacketVerifier(options: DownloadOptions) {
  const { verifier } = await downloadModels(
    {
      verifier: {
        repo: "Kellenok/PP-OCRv6_manga",
        revision: "d65838996a00ef6b1c73ca3a700d7a8c5fbbef8a",
        file: "det/manga_det.onnx",
        bytes: 1816958,
        sha256:
          "97c434ae8deaad83513fb132b605d5085a3af8ffac2cb15e2aa096815c206172",
      },
    },
    options,
  );
  return verifier;
}

async function downloadModels<K extends string>(
  assets: Record<K, ModelAsset>,
  options: DownloadOptions,
) {
  const progress = createCombinedDownloadProgress(
    options.onProgress,
    "Qwen Image 2.1",
  );
  const paths = {} as Record<K, string>;
  for (const key of Object.keys(assets) as K[]) {
    const file = assets[key];
    options.signal?.throwIfAborted();
    paths[key] = await ensureRemoteFile({
      modelDir: options.modelDir,
      url: hfResolveUrl(file.repo, file.file, file.revision),
      fileName: basename(file.file),
      label: `Qwen Image 2.1 ${key}`,
      expectedSha256: file.sha256,
      minimumBytes: file.bytes,
      maximumBytes: file.bytes,
      expectedTotalBytes: file.bytes,
      signal: options.signal,
      onProgress: progress.forFile(),
    });
  }
  return paths;
}
