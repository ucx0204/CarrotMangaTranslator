import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  FluxAssetProgress,
  FluxPythonBackend,
  FluxPythonRuntime,
} from "./types";
import { runCommand } from "./errors";

export function hasUsablePackageDir(
  packageDir: string,
  backend: FluxPythonBackend,
): boolean {
  const requiredModules =
    backend === "python-rocm"
      ? ["stable_diffusion_cpp", "PIL"]
      : ["torch", "diffusers", "transformers"];
  return requiredModules.every((name) => existsSync(join(packageDir, name)));
}

export async function verifyFluxPythonRuntime(
  pythonRuntime: FluxPythonRuntime,
  backend: FluxPythonBackend,
  signal?: AbortSignal,
): Promise<void> {
  const verifyScript =
    backend === "python-rocm"
      ? [
          "import importlib",
          "for name in ['stable_diffusion_cpp','PIL','huggingface_hub']:",
          "    importlib.import_module(name)",
          "print('ok')",
        ].join("\n")
      : [
          "import importlib, torch",
          "for name in ['diffusers','gguf','transformers','accelerate','safetensors','PIL','torchvision','sentencepiece','google.protobuf']:",
          "    importlib.import_module(name)",
          "print('ok')",
        ].join("\n");
  await runCommand(
    pythonRuntime.executable,
    [...pythonRuntime.args, "-c", verifyScript],
    {
      signal,
      env: pythonRuntime.env,
    },
  );
}

export async function ensureFluxPythonModelCache(options: {
  pythonRuntime: FluxPythonRuntime;
  modelDir: string;
  modelId: string;
  ignorePatterns?: string[];
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<void> {
  const markerPath = join(options.modelDir, ".mgt-flux-diffusers-model.json");
  const ignorePatterns = options.ignorePatterns ?? [];
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
      modelId?: string;
      ignorePatterns?: string[];
    };
    if (
      marker.modelId === options.modelId &&
      JSON.stringify(marker.ignorePatterns ?? []) ===
        JSON.stringify(ignorePatterns)
    ) {
      options.onProgress?.({
        progressText: "Flux Diffusers 모델 캐시 사용",
        detail: options.modelId,
        progressMode: "log-only",
        installLogLine: `캐시된 Diffusers Flux 모델을 사용합니다: ${options.modelId}`,
      });
      return;
    }
  } catch (_error) {
    // Model cache marker is best-effort; snapshot_download below is idempotent.
  }

  await mkdir(options.modelDir, { recursive: true });
  if (ignorePatterns.length > 0) {
    await rm(
      resolveHuggingFaceRepoCacheDir(options.modelDir, options.modelId),
      { recursive: true, force: true },
    );
  }
  options.onProgress?.({
    progressText: "Flux Diffusers 모델 준비 중",
    detail:
      ignorePatterns.length > 0
        ? `${options.modelId} · transformer 제외`
        : options.modelId,
    progressMode: "indeterminate",
    installLogLine:
      ignorePatterns.length > 0
        ? `Diffusers Flux 모델 캐시를 확인합니다: ${options.modelId} (GGUF transformer 사용, 원본 transformer 제외)`
        : `Diffusers Flux 모델 캐시를 확인합니다: ${options.modelId}`,
  });
  const downloadScript = [
    "from huggingface_hub import snapshot_download",
    "import json, sys",
    "ignore_patterns = json.loads(sys.argv[3])",
    "snapshot_download(repo_id=sys.argv[1], cache_dir=sys.argv[2], resume_download=True, ignore_patterns=ignore_patterns or None)",
  ].join("\n");
  await runCommand(
    options.pythonRuntime.executable,
    [
      ...options.pythonRuntime.args,
      "-c",
      downloadScript,
      options.modelId,
      options.modelDir,
      JSON.stringify(ignorePatterns),
    ],
    {
      signal: options.signal,
      env: {
        ...options.pythonRuntime.env,
        HF_HOME: options.modelDir,
        HUGGINGFACE_HUB_CACHE: join(options.modelDir, "hub"),
      },
      onLine: (line) =>
        options.onProgress?.({
          progressText: "Flux Diffusers 모델 준비 중",
          detail: options.modelId,
          progressMode: "indeterminate",
          installLogLine: line,
        }),
    },
  );
  await writeFile(
    markerPath,
    `${JSON.stringify(
      {
        modelId: options.modelId,
        ignorePatterns,
        cachedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function resolveHuggingFaceRepoCacheDir(
  cacheDir: string,
  repoId: string,
): string {
  return join(cacheDir, "hub", `models--${repoId.replace(/[\\/]/g, "--")}`);
}
