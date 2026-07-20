import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import type { KoharuInpaintingBackend } from "../../shared/inpaintingSettingsTypes";
import type { InpaintingRuntimeProgress } from "./inpaintingEngine";
import { runCommand } from "./fluxAssets/errors";
import { sha256FileSync } from "./fluxAssets/fileProbe";
import {
  ensureEmbeddedPythonPackagePath,
  findPythonCommand,
} from "./fluxAssets/pythonBootstrap";
import type { PythonCommand } from "./fluxAssets/types";

export type BubbleQualityModel = "sam2.1" | "sam3";

export type BubbleQualityWorkerLaunch = {
  args: string[];
  backend: string;
  env: NodeJS.ProcessEnv;
  executable: string;
  model: BubbleQualityModel;
};

const WORKER_FILE = "bubble-quality-worker.py";
const RTDETR_MODEL = {
  repo: "ogkalu/comic-text-and-bubble-detector",
  revision: "16e8a622f91fabc6b5b65c96d32d1183f8843546",
  files: ["config.json", "preprocessor_config.json", "model.safetensors"],
};
const SAM2_MODEL = {
  repo: "facebook/sam2.1-hiera-large",
  revision: "665f8e2ad61cf5f53d65644ff27c8ee525124610",
  files: [
    "config.json",
    "model.safetensors",
    "preprocessor_config.json",
    "processor_config.json",
  ],
};
const SAM3_MODEL = {
  repo: "facebook/sam3",
  revision: "3c879f39826c281e95690f02c7821c4de09afae7",
  files: [
    "config.json",
    "merges.txt",
    "model.safetensors",
    "processor_config.json",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
  ],
};

export async function ensureBubbleQualityWorkerLaunch(options: {
  backend: Exclude<KoharuInpaintingBackend, "auto">;
  dataRoot: string;
  requestedModel: BubbleQualityModel;
  signal?: AbortSignal;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
}): Promise<BubbleQualityWorkerLaunch> {
  const model = resolveAvailableBubbleQualityModel(
    options.requestedModel,
    options.backend,
  );
  const runtimeDir = join(options.dataRoot, "runtime", "bubble-quality");
  const packageDir = join(runtimeDir, "python-packages");
  const workerPath = join(runtimeDir, WORKER_FILE);
  const modelsDir = join(options.dataRoot, "models", "bubble-quality");
  await mkdir(runtimeDir, { recursive: true });
  const workerSource = resolveWorkerSource();
  await copyFile(workerSource, workerPath);
  const python = await findPythonCommand({
    runtimeDir,
    runtimeLabel: "말풍선 최고 품질",
    signal: options.signal,
    onProgress: options.onProgress,
  });
  const device = resolveBubbleQualityTorchDevice(options.backend);
  const env = buildRuntimeEnv(packageDir, modelsDir);
  if (isAbsolute(python.command) && python.args.length === 0) {
    ensureEmbeddedPythonPackagePath(python.command, packageDir);
  }
  await ensurePythonPackages({
    device,
    env,
    packageDir,
    python,
    runtimeDir,
    signal: options.signal,
    workerSource,
    onProgress: options.onProgress,
  });
  const rtdetrDir = await ensureModelSnapshot({
    env,
    label: "RT-DETR 말풍선 복구 모델",
    model: RTDETR_MODEL,
    modelDir: join(modelsDir, "rtdetr"),
    onProgress: options.onProgress,
    python,
    signal: options.signal,
  });
  const samSpec = model === "sam3" ? SAM3_MODEL : SAM2_MODEL;
  const samDir = await ensureModelSnapshot({
    env,
    label: model === "sam3" ? "SAM 3 실험 모델" : "SAM 2.1 경계 보정 모델",
    model: samSpec,
    modelDir: join(modelsDir, model === "sam3" ? "sam3" : "sam2.1"),
    onProgress: options.onProgress,
    python,
    signal: options.signal,
  });
  return {
    args: [
      ...python.args,
      "-u",
      workerPath,
      "--rtdetr-model-dir",
      rtdetrDir,
      "--sam-model-dir",
      samDir,
      "--sam-model",
      model,
      "--device",
      device,
    ],
    backend: options.backend,
    env,
    executable: python.command,
    model,
  };
}

export function resolveAvailableBubbleQualityModel(
  requested: BubbleQualityModel,
  backend: Exclude<KoharuInpaintingBackend, "auto">,
): BubbleQualityModel {
  if (
    requested === "sam3" &&
    backend === "cuda-native" &&
    Boolean(process.env.HF_TOKEN?.trim())
  ) {
    return "sam3";
  }
  return "sam2.1";
}

export function resolveBubbleQualityTorchDevice(
  backend: Exclude<KoharuInpaintingBackend, "auto">,
): "cpu" | "cuda" | "mps" {
  if (backend === "cuda-native") return "cuda";
  if (backend === "metal-native") return "mps";
  return "cpu";
}

function resolveWorkerSource(): string {
  const candidates = [
    process.resourcesPath
      ? join(process.resourcesPath, "app-runtime", WORKER_FILE)
      : "",
    join(process.cwd(), "out", "app-runtime", WORKER_FILE),
    join(process.cwd(), "src", "main", "runtime", WORKER_FILE),
  ];
  const source = candidates.find(
    (candidate) => candidate && existsSync(candidate),
  );
  if (!source) {
    throw new Error(`${WORKER_FILE}를 찾지 못했습니다.`);
  }
  return source;
}

async function ensurePythonPackages(options: {
  device: "cpu" | "cuda" | "mps";
  env: NodeJS.ProcessEnv;
  packageDir: string;
  python: PythonCommand;
  runtimeDir: string;
  signal?: AbortSignal;
  workerSource: string;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
}): Promise<void> {
  const markerPath = join(options.runtimeDir, ".bubble-quality-runtime.json");
  const signature = {
    pythonPackages: [
      "numpy>=1.26,<3",
      "pillow>=11,<13",
      "safetensors>=0.6,<1",
      "huggingface_hub>=0.36,<2",
      "transformers>=5.0,<6",
    ],
    torchDevice: options.device,
    workerHash: sha256FileSync(options.workerSource),
  };
  if (await isCurrentRuntime(markerPath, options.packageDir, signature)) return;
  await rm(options.packageDir, { recursive: true, force: true });
  await mkdir(options.packageDir, { recursive: true });
  options.onProgress?.({
    progressText: "말풍선 최고 품질 런타임 설치 중",
    detail: options.device.toUpperCase(),
    progressMode: "indeterminate",
    installLogLine: "RT-DETR 및 SAM용 Python 패키지를 자동 설치합니다.",
  });
  const torchArgs =
    options.device === "cpu" && process.platform !== "darwin"
      ? [
          "--index-url",
          "https://download.pytorch.org/whl/cpu",
          "torch",
          "torchvision",
        ]
      : ["torch", "torchvision"];
  await installTargetPackages(options, torchArgs);
  await installTargetPackages(options, signature.pythonPackages);
  await writeFile(
    markerPath,
    `${JSON.stringify(signature, null, 2)}\n`,
    "utf8",
  );
}

async function installTargetPackages(
  options: {
    env: NodeJS.ProcessEnv;
    packageDir: string;
    python: PythonCommand;
    signal?: AbortSignal;
    onProgress?: (progress: InpaintingRuntimeProgress) => void;
  },
  packages: string[],
): Promise<void> {
  await runCommand(
    options.python.command,
    [
      ...options.python.args,
      "-m",
      "pip",
      "install",
      "--target",
      options.packageDir,
      ...packages,
    ],
    {
      signal: options.signal,
      env: options.env,
      onLine: (line) =>
        options.onProgress?.({
          progressText: "말풍선 최고 품질 런타임 설치 중",
          detail: "RT-DETR + SAM",
          progressMode: "indeterminate",
          installLogLine: line,
        }),
    },
  );
}

async function isCurrentRuntime(
  markerPath: string,
  packageDir: string,
  signature: object,
): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    return (
      JSON.stringify(marker) === JSON.stringify(signature) &&
      ["torch", "transformers", "PIL", "numpy"].every((name) =>
        existsSync(join(packageDir, name)),
      )
    );
  } catch (_error) {
    return false;
  }
}

async function ensureModelSnapshot(options: {
  env: NodeJS.ProcessEnv;
  label: string;
  model: { repo: string; revision: string; files: string[] };
  modelDir: string;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
  python: PythonCommand;
  signal?: AbortSignal;
}): Promise<string> {
  const markerPath = join(options.modelDir, ".snapshot.json");
  const signature = {
    repo: options.model.repo,
    revision: options.model.revision,
    files: options.model.files,
  };
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    if (
      JSON.stringify(marker) === JSON.stringify(signature) &&
      options.model.files.every((file) =>
        existsSync(join(options.modelDir, file)),
      )
    ) {
      return options.modelDir;
    }
  } catch (_error) {
    // error-policy-allow: A missing or stale marker is repaired from the pinned snapshot below.
  }
  await mkdir(options.modelDir, { recursive: true });
  options.onProgress?.({
    progressText: `${options.label} 다운로드 중`,
    detail: options.model.repo,
    progressMode: "indeterminate",
    installLogLine: `${options.model.repo}@${options.model.revision.slice(0, 12)} 버전을 준비합니다.`,
  });
  const script = [
    "from huggingface_hub import snapshot_download",
    "import json, sys",
    "snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2], local_dir=sys.argv[3], allow_patterns=json.loads(sys.argv[4]), token=None)",
  ].join("\n");
  await runCommand(
    options.python.command,
    [
      ...options.python.args,
      "-c",
      script,
      options.model.repo,
      options.model.revision,
      options.modelDir,
      JSON.stringify(options.model.files),
    ],
    {
      signal: options.signal,
      env: options.env,
      onLine: (line) =>
        options.onProgress?.({
          progressText: `${options.label} 다운로드 중`,
          detail: options.model.repo,
          progressMode: "indeterminate",
          installLogLine: line,
        }),
    },
  );
  await writeFile(
    markerPath,
    `${JSON.stringify(signature, null, 2)}\n`,
    "utf8",
  );
  return options.modelDir;
}

function buildRuntimeEnv(
  packageDir: string,
  modelsDir: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONPATH: [packageDir, process.env.PYTHONPATH]
      .filter(Boolean)
      .join(delimiter),
    HF_HOME: modelsDir,
    HUGGINGFACE_HUB_CACHE: join(modelsDir, "hub"),
    HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
    HF_HUB_DISABLE_PROGRESS_BARS: "1",
  };
}
