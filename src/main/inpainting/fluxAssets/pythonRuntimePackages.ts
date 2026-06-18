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
    "snapshot_download(repo_id=sys.argv[1], cache_dir=sys.argv[2], ignore_patterns=ignore_patterns or None)",
  ].join("\n");
  let emittedSymlinkWarning = false;
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
        HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
      },
      onLine: (line) => {
        const installLogLine = normalizeHuggingFaceModelCacheLogLine(
          line,
          () => {
            if (emittedSymlinkWarning) {
              return null;
            }
            emittedSymlinkWarning = true;
            return "Windows 심볼릭 링크 경고입니다. 다운로드는 계속됩니다. 개발자 모드를 켜지 않아도 되지만 디스크 사용량이 더 늘 수 있습니다.";
          },
        );
        if (!installLogLine) {
          return;
        }
        options.onProgress?.({
          progressText: "Flux Diffusers 모델 준비 중",
          detail: options.modelId,
          progressMode: "indeterminate",
          installLogLine,
        });
      },
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

function normalizeHuggingFaceModelCacheLogLine(
  line: string,
  onSymlinkWarning: () => string | null,
): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  if (/resume_download.*deprecated|warnings\.warn\(/i.test(trimmed)) {
    return null;
  }
  if (
    /cache-system uses symlinks|support symlinks on Windows|enable-your-device-for-development|warnings\.warn\(message\)/i.test(
      trimmed,
    )
  ) {
    return onSymlinkWarning();
  }
  return trimmed;
}
