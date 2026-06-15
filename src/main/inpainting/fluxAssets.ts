import { once } from "node:events";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { FluxBackend } from "../../shared/types";
import { sanitizeFluxRuntimeStderr, type FluxWorkerBackend, type FluxWorkerLaunchSpec } from "./fluxWorker";

const AdmZip = require("adm-zip");

export const FLUX_RUNTIME_EXECUTABLE = "mgt-flux-klein.exe";
export const FLUX_MODEL_REPO = "unsloth/FLUX.2-klein-4B-GGUF";
export const FLUX_MODEL_FILE = "flux-2-klein-4b-Q4_K_M.gguf";
export const FLUX_VAE_REPO = "black-forest-labs/FLUX.2-small-decoder";
export const FLUX_VAE_FILE = "diffusion_pytorch_model.safetensors";
const FLUX_RUNNER_DIR = "mgt-flux-klein";
const FLUX_CUDA_RUNTIME_DIR = "mgt-flux-cuda12.9";
const FLUX_ZLUDA_SUPPORT_RUNTIME_DIR = "mgt-flux-zluda-support";
const FLUX_CUDA_RUNTIME_MARKER = ".mgt-runtime.json";
const FLUX_PYTHON_WORKER = "flux-klein-python-worker.py";
const FLUX_SDCPP_WORKER = "flux-klein-sdcpp-worker.py";
const FLUX_PYTHON_RUNTIME_MARKER = ".mgt-flux-python-runtime.json";
const FLUX_ROCM_PREBUILT_RUNTIME_SCHEMA = 1;
const WINDOWS_MSVC_COMPILER_TARGET = "x86_64-pc-windows-msvc";
const WINDOWS_DYNAMIC_RUNTIME_LIB_NAMES = ["msvcrt.lib", "msvcprt.lib", "vcruntime.lib", "ucrt.lib", "oldnames.lib"];
const DEFAULT_AMD_GPU_TARGETS = [
  // Keep this in sync with scripts/build-flux-rocm-runtime.cjs. ROCm/HIP wants
  // concrete LLVM targets here, not grouped labels such as "gfx110X".
  "gfx908",
  "gfx90a",
  "gfx1030",
  "gfx1031",
  "gfx1032",
  "gfx1033",
  "gfx1034",
  "gfx1035",
  "gfx1036",
  "gfx1100",
  "gfx1101",
  "gfx1102",
  "gfx1103",
  "gfx1150",
  "gfx1151",
  "gfx1152",
  "gfx1153",
  "gfx1200",
  "gfx1201"
];
const WINDOWS_SYSTEM_IMPORT_LIB_NAMES = [
  "kernel32.lib",
  "user32.lib",
  "gdi32.lib",
  "winspool.lib",
  "shell32.lib",
  "ole32.lib",
  "oleaut32.lib",
  "uuid.lib",
  "comdlg32.lib",
  "advapi32.lib"
];
const FLUX_ROCM_PREBUILT_RUNTIME_MANIFEST = "mgt-flux-rocm-runtime.json";
const FLUX_DIFFUSERS_MODEL_ID = "black-forest-labs/FLUX.2-klein-4B";
const FLUX_SDCPP_VAE_FILE = "full_encoder_small_decoder.safetensors";
const FLUX_SDCPP_LLM_REPO = "unsloth/Qwen3-4B-GGUF";
const FLUX_SDCPP_LLM_FILE = "Qwen3-4B-Q4_K_M.gguf";
const FLUX_ROCM_WINDOWS_VERSION = "7.2.1";
const FLUX_CPU_TORCH_INDEX_URL = "https://download.pytorch.org/whl/cpu";
const FLUX_PYTHON_DEFAULT_MODE = "klein-edit-composite";
const FLUX_EMBED_PYTHON_VERSION = "3.12.7";
const FLUX_ROCM_PREBUILT_RUNTIME_FILE =
  `mgt-flux-rocm-win-x64-rocm${FLUX_ROCM_WINDOWS_VERSION}-py${FLUX_EMBED_PYTHON_VERSION}-sdcpp.zip`;
const FLUX_ROCM_PREBUILT_RUNTIME_URL =
  `https://github.com/ucx0204/Gemma4MangaTranslatorForKorean/releases/download/flux-runtime/${FLUX_ROCM_PREBUILT_RUNTIME_FILE}`;
const FLUX_GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py";
const FLUX_BOOTSTRAP_PYTHON_MARKER = ".mgt-flux-bootstrap-python.json";
const WINDOWS_LEGACY_MAX_PATH = 260;
const WINDOWS_PATH_SAFETY_MARGIN = 8;
const ROCM_LONGEST_LIBRARY_ENTRY = join(
  "_rocm_sdk_libraries_custom",
  "bin",
  "hipblaslt",
  "library",
  "TensileLibrary_B8B8_B8B8_HA_Bias_SAB_SCD_SAV_UA_Type_B8B8_HPA_Contraction_l_Ailk_Bjlk_Cijk_Dijk_gfx1200.co"
);
const ROCM_LONGEST_FINAL_ENTRY = join("p", ROCM_LONGEST_LIBRARY_ENTRY);
const ROCM_LONGEST_PIP_TEMP_ENTRY = join("t", "pip-target-xxxxxxxx", "lib", "python", ROCM_LONGEST_LIBRARY_ENTRY);
const CUDA_REDIST_BASE_URL = "https://developer.download.nvidia.com/compute/cuda/redist";
const CUDNN_REDIST_BASE_URL = "https://developer.download.nvidia.com/compute/cudnn/redist";
const CUDA_REDIST_MANIFEST_URL = `${CUDA_REDIST_BASE_URL}/redistrib_12.9.0.json`;
const CUDNN_REDIST_MANIFEST_URL = `${CUDNN_REDIST_BASE_URL}/redistrib_9.21.0.json`;
const FLUX_CUDA_DLLS = new Set(["cublas64_12.dll", "cublasLt64_12.dll", "cudart64_12.dll", "curand64_10.dll"]);
const FLUX_ZLUDA_SUPPORT_DLLS = new Set(["curand64_10.dll"]);
const FLUX_CUDNN_DLLS = new Set([
  "cudnn64_9.dll",
  "cudnn_adv64_9.dll",
  "cudnn_cnn64_9.dll",
  "cudnn_engines_precompiled64_9.dll",
  "cudnn_engines_runtime_compiled64_9.dll",
  "cudnn_engines_tensor_ir64_9.dll",
  "cudnn_graph64_9.dll",
  "cudnn_heuristic64_9.dll",
  "cudnn_ops64_9.dll"
]);

export type FluxAssetProgress = {
  progressText: string;
  detail?: string;
  progressMode?: "determinate" | "indeterminate" | "log-only";
  progressPercent?: number;
  progressBytes?: number;
  progressTotalBytes?: number;
  installLogLine?: string;
};

type RemoteFileMetadata = {
  url: string;
  bytes: number;
  downloadedAt: string;
};

type WindowsNativeBuildEnv = {
  sdkVersion?: string;
  pathEntries: string[];
  includePaths: string[];
  libPaths: string[];
};

type NvidiaRedistPackage = {
  relative_path: string;
  size?: number;
};

type PythonCommand = {
  command: string;
  args: string[];
};

type FluxPythonRuntime = PythonCommand & {
  mode: "venv" | "target";
  executable: string;
  env?: NodeJS.ProcessEnv;
  packageDir: string | null;
};

type FluxPythonInstallBatch = {
  id: string;
  progressText: string;
  detail: string;
  installLogLine: string;
  pipArgs: string[];
};

type FluxPythonRuntimeLayout = {
  runtimeName: string;
  runtimeDir: string;
  venvDir: string;
  venvPythonPath: string;
  packageDir: string;
  workerPath: string;
  markerPath: string;
  tempDir: string;
};

type FluxPythonBackend = "python-rocm" | "python-cpu";
type FluxRuntimeBackend = FluxBackend | FluxPythonBackend;

export async function ensureMgtFluxKleinRuntime(options: {
  runtimeDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  await mkdir(options.runtimeDir, { recursive: true });
  const runtimePath = await ensureManagedFluxRunner(options);
  await ensureFluxCudaRuntime(options);
  options.onProgress?.({
    progressText: "Flux 런타임 캐시 사용",
    detail: basename(runtimePath),
    progressMode: "log-only",
    installLogLine: `MGT Flux Klein 런타임을 사용합니다: ${basename(runtimePath)}`
  });
  return runtimePath;
}

export async function ensureFluxWorkerLaunch(options: {
  runtimeDir: string;
  modelDir: string;
  backend: FluxRuntimeBackend;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<FluxWorkerLaunchSpec> {
  const backend = resolveFluxWorkerBackend(options.backend);
  if (backend === "cuda-native") {
    const runtimePath = await ensureMgtFluxKleinRuntime(options);
    return {
      backend,
      executable: runtimePath,
      runtimePath,
      label: "Flux Klein CUDA",
      args: []
    };
  }
  if (backend === "zluda-native") {
    await mkdir(options.runtimeDir, { recursive: true });
    const runtimePath = await ensureManagedFluxRunner(options);
    const cudaRuntimeDir = await ensureFluxZludaSupportRuntime(options);
    const zludaRuntimeRoot = join(options.runtimeDir, "koharu-zluda");
    options.onProgress?.({
      progressText: "Flux ZLUDA 런타임 준비 중",
      detail: "Koharu/Candle ZLUDA",
      progressMode: "log-only",
      installLogLine: "AMD GPU에서는 NVIDIA와 같은 Flux Klein 실행기를 ZLUDA/HIP 경로로 실행하고, 필요한 CUDA 보조 DLL만 함께 준비합니다."
    });
    return {
      backend,
      executable: runtimePath,
      runtimePath,
      label: "Flux Klein ZLUDA",
      args: [
        "--require-zluda",
        "--zluda-runtime-root",
        zludaRuntimeRoot,
        "--cuda-runtime-dir",
        cudaRuntimeDir
      ],
      env: {
        KOHARU_DATA_ROOT: zludaRuntimeRoot
      }
    };
  }
  if (backend === "python-rocm" || backend === "python-cpu") {
    return ensureFluxPythonRuntime({ ...options, backend });
  }
  throw new Error(`지원하지 않는 Flux 런타임입니다: ${backend}`);
}

async function ensureManagedFluxRunner(options: {
  runtimeDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  const managedDir = join(options.runtimeDir, FLUX_RUNNER_DIR);
  const managedPath = join(managedDir, FLUX_RUNTIME_EXECUTABLE);

  const source = findFirstExecutable([
    process.env.MGT_FLUX_KLEIN_EXE,
    process.resourcesPath ? join(process.resourcesPath, "tools", FLUX_RUNNER_DIR, FLUX_RUNTIME_EXECUTABLE) : undefined,
    join(process.cwd(), "tools", FLUX_RUNNER_DIR, FLUX_RUNTIME_EXECUTABLE)
  ]);
  if (!source) {
    throw new Error(
      `${FLUX_RUNTIME_EXECUTABLE}를 찾지 못했습니다. 설치 파일에 Flux Klein 실행 파일이 포함되어 있어야 합니다. ` +
        `개발 환경에서는 node scripts/prepare-flux-klein-runner.cjs를 실행하거나 MGT_FLUX_KLEIN_EXE로 경로를 지정하세요.`
    );
  }

  throwIfAborted(options.signal);
  await mkdir(managedDir, { recursive: true });
  if (isExecutableFile(managedPath) && sha256FileSync(managedPath) === sha256FileSync(source)) {
    return managedPath;
  }
  await copyFile(source, managedPath);
  options.onProgress?.({
    progressText: "Flux 실행 파일 준비 중",
    detail: FLUX_RUNTIME_EXECUTABLE,
    progressMode: "log-only",
    installLogLine: `Flux 실행 파일을 앱 데이터 캐시에 갱신했습니다: ${FLUX_RUNTIME_EXECUTABLE}`
  });
  return managedPath;
}

async function ensureFluxPythonRuntime(options: {
  runtimeDir: string;
  modelDir: string;
  backend: FluxPythonBackend;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<FluxWorkerLaunchSpec> {
  await mkdir(options.runtimeDir, { recursive: true });
  const layout = resolveFluxPythonRuntimeLayout(options.runtimeDir, options.backend);
  const { runtimeDir, venvPythonPath, packageDir, workerPath, markerPath } = layout;
  const runtimeInstallBatches = resolvePythonRuntimeInstallBatches(options.backend);
  const buildPackages = resolvePythonBuildPackages(options.backend);
  const extraPackages = resolvePythonFluxPackages(options.backend);
  const workerFile = resolveFluxPythonWorkerFile(options.backend);
  const workerSource = findFluxPythonWorkerSource(workerFile);
  const workerHash = workerSource ? sha256FileSync(workerSource) : "missing";
  const expectedMarker = {
    backend: options.backend,
    runtimeInstallBatches: runtimeInstallBatches.map((batch) => ({ id: batch.id, pipArgs: batch.pipArgs })),
    buildPackages,
    packages: extraPackages,
    worker: workerFile,
    workerHash
  };

  let pythonRuntime = await resolveCurrentFluxPythonRuntime({
    runtimeDir,
    venvPythonPath,
    packageDir,
    markerPath,
    expectedMarker
  });

  if (!pythonRuntime) {
    if (options.backend === "python-rocm" && process.platform === "win32") {
      pythonRuntime = await ensurePrebuiltFluxRocmPythonRuntime({
        layout,
        expectedMarker,
        signal: options.signal,
        onProgress: options.onProgress
      });
    }

    if (!pythonRuntime) {
      if (options.backend === "python-rocm" && process.platform === "win32" && !shouldAllowFluxRocmSourceBuildFallback()) {
        throw new Error(
          "Flux ROCm prebuilt 런타임을 준비하지 못했습니다. 사용자 PC에서 C++/ROCm 소스 빌드는 비활성화되어 있습니다. " +
            "GitHub Release의 mgt-flux-rocm 런타임 ZIP을 확인하거나 MGT_FLUX_ROCM_ALLOW_SOURCE_BUILD=1로 개발용 소스 빌드를 명시적으로 허용하세요."
        );
      }

      await rm(runtimeDir, { recursive: true, force: true });
      await mkdir(runtimeDir, { recursive: true });
      await ensureFluxPythonWorker(runtimeDir, workerFile);
      options.onProgress?.({
        progressText: options.backend === "python-rocm" ? "Flux ROCm 런타임 설치 중" : "Flux CPU 런타임 설치 중",
        detail: "Python target package install",
        progressMode: "log-only",
        installLogLine: "Flux 전용 패키지 폴더에 Python 패키지를 설치합니다."
      });
      const basePython = await findPythonCommand({
        runtimeDir,
        signal: options.signal,
        onProgress: options.onProgress
      });
      const runtimeMode = "target" as const;
      const installPython: PythonCommand = basePython;
      await mkdir(packageDir, { recursive: true });
      if (isAbsolute(basePython.command) && basePython.args.length === 0) {
        ensureEmbeddedPythonPackagePath(basePython.command, packageDir);
      }

      let installEnv = buildTargetPythonEnv(
        runtimeDir,
        packageDir,
        options.backend === "python-rocm" && process.platform === "win32" ? "python-cpu" : options.backend,
        { requireNativeBuildEnv: false }
      );
      await runCommand(installPython.command, [...installPython.args, "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"], {
        signal: options.signal,
        env: installEnv,
        onLine: (line) => emitPythonInstallLog(options, line)
      });
      if (buildPackages.length > 0) {
        options.onProgress?.({
          progressText: "Flux 빌드 도구 설치 중",
          detail: buildPackages.join(" "),
          progressMode: "indeterminate",
          installLogLine: "stable-diffusion.cpp Python 바인딩 빌드 도구를 먼저 설치합니다."
        });
        await runCommand(installPython.command, [
          ...installPython.args,
          "-m",
          "pip",
          "install",
          "--upgrade",
          ...buildPackages
        ], {
          signal: options.signal,
          env: installEnv,
          onLine: (line) => emitPythonInstallLog(options, line)
        });
      }
      for (const batch of runtimeInstallBatches) {
        options.onProgress?.({
          progressText: batch.progressText,
          detail: batch.detail,
          progressMode: "indeterminate",
          installLogLine: batch.installLogLine
        });
        await runCommand(installPython.command, [
          ...installPython.args,
          "-m",
          "pip",
          "install",
          "--target",
          packageDir,
          ...batch.pipArgs
        ], {
          signal: options.signal,
          env: installEnv,
          onLine: (line) => emitPythonInstallLog(options, line)
        });
      }
      if (options.backend === "python-rocm" && process.platform === "win32") {
        await initializeWindowsRocmSdk({
          python: installPython,
          packageDir,
          runtimeDir,
          signal: options.signal,
          onProgress: options.onProgress
        });
        installEnv = buildTargetPythonEnv(runtimeDir, packageDir, options.backend, { requireNativeBuildEnv: true });
      }
      options.onProgress?.({
        progressText: "Flux Python 패키지 설치 중",
        detail: extraPackages.join(" "),
        progressMode: "indeterminate",
        installLogLine: options.backend === "python-rocm"
          ? "stable-diffusion.cpp Python 바인딩을 ROCm/HIP용으로 빌드합니다."
          : "diffusers/transformers/accelerate 패키지를 설치합니다."
      });
      await runCommand(installPython.command, [
        ...installPython.args,
        "-m",
        "pip",
        "install",
        "--target",
        packageDir,
        ...extraPackages
      ], {
        signal: options.signal,
        env: installEnv,
        onLine: (line) => emitPythonInstallLog(options, line)
      });
      pythonRuntime = {
        mode: "target",
        command: installPython.command,
        executable: installPython.command,
        args: installPython.args,
        env: installEnv,
        packageDir
      };
      await verifyFluxPythonRuntime(pythonRuntime, options.backend, options.signal);
      await writeFile(markerPath, `${JSON.stringify({
        ...expectedMarker,
        runtimeMode,
        pythonPath: pythonRuntime.executable,
        packageDir: pythonRuntime.packageDir
      }, null, 2)}\n`, "utf8");
    }
  } else {
    await ensureFluxPythonWorker(runtimeDir, workerFile);
  }
  if (!pythonRuntime) {
    throw new Error("Flux Python 런타임 준비 상태를 확인하지 못했습니다.");
  }

  await mkdir(options.modelDir, { recursive: true });

  if (options.backend === "python-rocm") {
    const diffusionModelPath = await ensureRemoteFile({
      modelDir: options.modelDir,
      fileName: FLUX_MODEL_FILE,
      label: "Flux Klein 4B GGUF",
      url: hfResolveUrl(FLUX_MODEL_REPO, FLUX_MODEL_FILE),
      signal: options.signal,
      onProgress: options.onProgress
    });
    const vaePath = await ensureRemoteFile({
      modelDir: options.modelDir,
      fileName: FLUX_SDCPP_VAE_FILE,
      label: "Flux small decoder",
      url: hfResolveUrl(FLUX_VAE_REPO, FLUX_SDCPP_VAE_FILE),
      signal: options.signal,
      onProgress: options.onProgress
    });
    const llmPath = await ensureRemoteFile({
      modelDir: options.modelDir,
      fileName: FLUX_SDCPP_LLM_FILE,
      label: "Flux text encoder GGUF",
      url: hfResolveUrl(FLUX_SDCPP_LLM_REPO, FLUX_SDCPP_LLM_FILE),
      signal: options.signal,
      onProgress: options.onProgress
    });
    options.onProgress?.({
      progressText: "Flux stable-diffusion.cpp 런타임 준비 완료",
      detail: "ROCm · GGUF Q4_K_M",
      progressMode: "log-only",
      installLogLine: "Flux stable-diffusion.cpp ROCm/HIP + GGUF 런타임을 사용합니다."
    });
    return {
      backend: options.backend,
      executable: pythonRuntime.executable,
      runtimePath: pythonRuntime.executable,
      label: "Flux stable-diffusion.cpp ROCm",
      args: [
        ...pythonRuntime.args,
        "-u",
        workerPath,
        "--backend",
        "rocm",
        "--diffusion-model",
        diffusionModelPath,
        "--vae",
        vaePath,
        "--llm",
        llmPath
      ],
      env: {
        ...pythonRuntime.env,
        HF_HOME: options.modelDir,
        HUGGINGFACE_HUB_CACHE: join(options.modelDir, "hub")
      }
    };
  }

  const modelId = process.env.MANGA_TRANSLATOR_FLUX_PYTHON_MODEL_ID ?? process.env.MGT_FLUX_PYTHON_MODEL_ID ?? FLUX_DIFFUSERS_MODEL_ID;
  const mode = resolveFluxPythonMode();
  await ensureFluxPythonModelCache({
    pythonRuntime,
    modelDir: options.modelDir,
    modelId,
    ignorePatterns: [],
    signal: options.signal,
    onProgress: options.onProgress
  });
  options.onProgress?.({
    progressText: "Flux Python 런타임 준비 완료",
    detail: `CPU · ${modelId}`,
    progressMode: "log-only",
    installLogLine: "Flux Python CPU 런타임을 사용합니다."
  });
  return {
    backend: options.backend,
    executable: pythonRuntime.executable,
    runtimePath: pythonRuntime.executable,
    label: "Flux Python CPU",
    args: [
      ...pythonRuntime.args,
      "-u",
      workerPath,
      "--backend",
      "cpu",
      "--model-id",
      modelId,
      "--mode",
      mode,
      "--cache-dir",
      options.modelDir
    ],
    env: {
      ...pythonRuntime.env,
      HF_HOME: options.modelDir,
      HUGGINGFACE_HUB_CACHE: join(options.modelDir, "hub")
    }
  };
}

async function ensurePrebuiltFluxRocmPythonRuntime(options: {
  layout: FluxPythonRuntimeLayout;
  expectedMarker: {
    backend: FluxPythonBackend;
    runtimeInstallBatches: Array<{ id: string; pipArgs: string[] }>;
    buildPackages: string[];
    packages: string[];
    worker: string;
    workerHash: string;
  };
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<FluxPythonRuntime | null> {
  const archiveUrl = resolveFluxRocmPrebuiltRuntimeUrl();
  if (!archiveUrl || !shouldUsePrebuiltFluxRocmRuntime()) {
    return null;
  }

  const archiveName = resolveArchiveFileName(archiveUrl, FLUX_ROCM_PREBUILT_RUNTIME_FILE);
  options.onProgress?.({
    progressText: "Flux ROCm prebuilt 런타임 준비 중",
    detail: archiveName,
    progressMode: "log-only",
    installLogLine: `Flux ROCm prebuilt 런타임을 사용합니다: ${archiveName}`
  });
  const archivePath = await ensurePrebuiltFluxRocmRuntimeArchive({
    urlOrPath: archiveUrl,
    outputPath: join(dirname(options.layout.runtimeDir), ".downloads", archiveName),
    signal: options.signal,
    label: archiveName,
    onProgress: options.onProgress
  });

  await rm(options.layout.runtimeDir, { recursive: true, force: true });
  await mkdir(options.layout.runtimeDir, { recursive: true });
  await extractLargeZipSafely(archivePath, options.layout.runtimeDir);
  await ensureFluxPythonWorker(options.layout.runtimeDir, options.expectedMarker.worker);
  await validatePrebuiltFluxRocmRuntime(options.layout.runtimeDir);

  const pythonPath = managedFluxBootstrapPythonPath(options.layout.runtimeDir);
  if (!isExecutableFile(pythonPath)) {
    throw new Error(`Flux ROCm prebuilt 런타임에 Python 실행 파일이 없습니다: ${pythonPath}`);
  }
  if (!hasUsablePackageDir(options.layout.packageDir, "python-rocm")) {
    throw new Error(`Flux ROCm prebuilt 런타임에 필요한 Python 패키지가 없습니다: ${options.layout.packageDir}`);
  }
  ensureEmbeddedPythonPackagePath(pythonPath, options.layout.packageDir);

  const pythonRuntime: FluxPythonRuntime = {
    mode: "target",
    command: pythonPath,
    executable: pythonPath,
    args: [],
    env: buildTargetPythonEnv(options.layout.runtimeDir, options.layout.packageDir, "python-rocm"),
    packageDir: options.layout.packageDir
  };
  await verifyFluxPythonRuntime(pythonRuntime, "python-rocm", options.signal);
  await writeFile(options.layout.markerPath, `${JSON.stringify({
    ...options.expectedMarker,
    runtimeMode: "target",
    pythonPath: pythonRuntime.executable,
    packageDir: pythonRuntime.packageDir,
    prebuiltRuntimeUrl: archiveUrl,
    prebuiltRuntimeFile: archiveName,
    installedAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
  options.onProgress?.({
    progressText: "Flux ROCm prebuilt 런타임 준비 완료",
    detail: archiveName,
    progressMode: "log-only",
    installLogLine: "Flux ROCm prebuilt 런타임 검증이 완료되었습니다."
  });
  return pythonRuntime;
}

async function ensurePrebuiltFluxRocmRuntimeArchive(options: {
  urlOrPath: string;
  outputPath: string;
  signal?: AbortSignal;
  label: string;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  const parsed = parseMaybeUrl(options.urlOrPath);
  if (parsed && ["http:", "https:"].includes(parsed.protocol)) {
    await downloadToFile({
      url: options.urlOrPath,
      outputPath: options.outputPath,
      signal: options.signal,
      progressText: "Flux ROCm prebuilt 런타임 다운로드 중",
      label: options.label,
      onProgress: options.onProgress
    });
    return options.outputPath;
  }

  const sourcePath = parsed?.protocol === "file:" ? decodeURIComponent(parsed.pathname) : options.urlOrPath;
  const normalizedSourcePath = process.platform === "win32" && sourcePath.startsWith("/") && /^[A-Za-z]:/.test(sourcePath.slice(1))
    ? sourcePath.slice(1)
    : sourcePath;
  if (!isUsableFile(normalizedSourcePath)) {
    throw new Error(`Flux ROCm prebuilt 런타임 파일을 찾지 못했습니다: ${options.urlOrPath}`);
  }
  await mkdir(dirname(options.outputPath), { recursive: true });
  await copyFile(normalizedSourcePath, options.outputPath);
  options.onProgress?.({
    progressText: "Flux ROCm prebuilt 런타임 파일 복사 완료",
    detail: basename(normalizedSourcePath),
    progressMode: "log-only",
    installLogLine: `로컬 Flux ROCm prebuilt 런타임을 사용합니다: ${normalizedSourcePath}`
  });
  return options.outputPath;
}

function resolveArchiveFileName(urlOrPath: string, fallback: string): string {
  const parsed = parseMaybeUrl(urlOrPath);
  if (parsed) {
    return basename(decodeURIComponent(parsed.pathname)) || fallback;
  }
  return basename(urlOrPath) || fallback;
}

function parseMaybeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

async function validatePrebuiltFluxRocmRuntime(runtimeDir: string): Promise<void> {
  const manifestPath = join(runtimeDir, FLUX_ROCM_PREBUILT_RUNTIME_MANIFEST);
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Flux ROCm prebuilt manifest를 읽지 못했습니다: ${manifestPath}. ${message}`, { cause: error });
  }
  const schemaVersion = Number(manifest.schemaVersion);
  if (schemaVersion !== FLUX_ROCM_PREBUILT_RUNTIME_SCHEMA) {
    throw new Error(`Flux ROCm prebuilt manifest 버전이 맞지 않습니다 (${manifest.schemaVersion}).`);
  }
  if (manifest.backend !== "python-rocm") {
    throw new Error(`Flux ROCm prebuilt manifest backend가 맞지 않습니다 (${String(manifest.backend)}).`);
  }
  if (manifest.rocmVersion !== FLUX_ROCM_WINDOWS_VERSION) {
    throw new Error(`Flux ROCm prebuilt ROCm 버전이 맞지 않습니다 (${String(manifest.rocmVersion)}).`);
  }
  if (manifest.pythonVersion !== FLUX_EMBED_PYTHON_VERSION) {
    throw new Error(`Flux ROCm prebuilt Python 버전이 맞지 않습니다 (${String(manifest.pythonVersion)}).`);
  }
}

export function resolveFluxPythonRuntimeLayout(
  baseRuntimeDir: string,
  backend: FluxPythonBackend
): FluxPythonRuntimeLayout {
  const runtimeName = backend === "python-rocm" ? "mgt-flux-python-rocm" : "mgt-flux-python-cpu";
  const useShortRocmLayout = backend === "python-rocm" && process.platform === "win32";
  const runtimeDir = useShortRocmLayout ? resolveWindowsRocmFluxRuntimeDir(baseRuntimeDir) : join(baseRuntimeDir, runtimeName);
  const venvDir = useShortRocmLayout ? join(runtimeDir, "v") : join(runtimeDir, ".venv");
  const packageDir = useShortRocmLayout ? join(runtimeDir, "p") : join(runtimeDir, "python-packages");
  const workerFile = resolveFluxPythonWorkerFile(backend);
  return {
    runtimeName,
    runtimeDir,
    venvDir,
    venvPythonPath: pythonExecutablePath(venvDir),
    packageDir,
    workerPath: join(runtimeDir, workerFile),
    markerPath: join(runtimeDir, FLUX_PYTHON_RUNTIME_MARKER),
    tempDir: resolveFluxRuntimeTempDir(runtimeDir)
  };
}

function resolveWindowsRocmFluxRuntimeDir(baseRuntimeDir: string): string {
  const configured = process.env.MANGA_TRANSLATOR_FLUX_ROCM_RUNTIME_DIR ?? process.env.MGT_FLUX_ROCM_RUNTIME_DIR;
  if (configured?.trim()) {
    return resolve(configured.trim());
  }

  const rocmDirName = `r${FLUX_ROCM_WINDOWS_VERSION.replace(/\D/g, "")}`;
  const dataRoot = resolve(baseRuntimeDir, "..", "..", "..");
  const dataRootCandidate = join(dataRoot, "fx", rocmDirName);
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const localCandidate = localAppData ? join(localAppData, "MGTFlux", rocmDirName) : null;
  const candidates = [dataRootCandidate, localCandidate].filter((candidate): candidate is string => Boolean(candidate));

  const dataRootIsSafe = isRocmRuntimePathShortEnough(dataRootCandidate);
  if (dataRootIsSafe) {
    return dataRootCandidate;
  }
  const localIsSafe = localCandidate ? isRocmRuntimePathShortEnough(localCandidate) : false;
  if (localCandidate && localIsSafe) {
    return localCandidate;
  }
  return candidates.sort((a, b) => a.length - b.length)[0] ?? dataRootCandidate;
}

function isRocmRuntimePathShortEnough(runtimeDir: string): boolean {
  const longestRuntimePath = Math.max(
    join(runtimeDir, ROCM_LONGEST_FINAL_ENTRY).length,
    join(runtimeDir, ROCM_LONGEST_PIP_TEMP_ENTRY).length
  );
  return longestRuntimePath < WINDOWS_LEGACY_MAX_PATH - WINDOWS_PATH_SAFETY_MARGIN;
}

function resolveFluxRuntimeTempDir(runtimeDir: string): string {
  return join(runtimeDir, "t");
}

async function ensureFluxCudaRuntime(options: {
  runtimeDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<void> {
  const cudaDir = join(options.runtimeDir, FLUX_CUDA_RUNTIME_DIR);
  if (await isCurrentFluxCudaRuntime(cudaDir)) {
    options.onProgress?.({
      progressText: "Flux CUDA 런타임 캐시 사용",
      detail: FLUX_CUDA_RUNTIME_DIR,
      progressMode: "log-only",
      installLogLine: "캐시된 Flux CUDA/cuDNN 런타임을 사용합니다."
    });
    return;
  }

  await rm(cudaDir, { recursive: true, force: true });
  await mkdir(cudaDir, { recursive: true });
  const downloadsDir = join(options.runtimeDir, ".downloads");
  await mkdir(downloadsDir, { recursive: true });

  const cudaManifest = await readJsonUrl(CUDA_REDIST_MANIFEST_URL, options.signal);
  const cudaPackages: NvidiaRedistPackage[] = [
    readNvidiaRedistPackage(cudaManifest, "libcublas", "windows-x86_64"),
    readNvidiaRedistPackage(cudaManifest, "cuda_cudart", "windows-x86_64"),
    readNvidiaRedistPackage(cudaManifest, "libcurand", "windows-x86_64")
  ].filter((entry): entry is NvidiaRedistPackage => Boolean(entry));
  if (cudaPackages.length !== 3) {
    throw new Error("NVIDIA CUDA 12.9 런타임 목록에서 필요한 DLL 패키지를 찾지 못했습니다.");
  }

  const cudnnManifest = await readJsonUrl(CUDNN_REDIST_MANIFEST_URL, options.signal);
  const cudnnPackage = readNvidiaRedistPackage(cudnnManifest, "cudnn", "windows-x86_64", "cuda12");
  if (!cudnnPackage) {
    throw new Error("NVIDIA cuDNN 9.21 CUDA 12 런타임 패키지를 찾지 못했습니다.");
  }

  for (const entry of cudaPackages) {
    const archivePath = await downloadRuntimeArchive({
      ...options,
      downloadsDir,
      entry,
      baseUrl: CUDA_REDIST_BASE_URL,
      label: "Flux CUDA 런타임"
    });
    extractSelectedZipEntries(archivePath, cudaDir, (fileName) => FLUX_CUDA_DLLS.has(fileName));
  }

  const cudnnArchivePath = await downloadRuntimeArchive({
    ...options,
    downloadsDir,
    entry: cudnnPackage,
    baseUrl: CUDNN_REDIST_BASE_URL,
    label: "Flux cuDNN 런타임"
  });
  extractSelectedZipEntries(cudnnArchivePath, cudaDir, (fileName) => FLUX_CUDNN_DLLS.has(fileName));

  if (!(await hasFluxCudaRuntimeFiles(cudaDir))) {
    throw new Error("Flux CUDA/cuDNN 런타임 설치가 완료되지 않았습니다.");
  }
  await writeFile(runtimeMarkerPath(cudaDir), `${JSON.stringify({
    cudaManifest: CUDA_REDIST_MANIFEST_URL,
    cudnnManifest: CUDNN_REDIST_MANIFEST_URL,
    installedAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
  options.onProgress?.({
    progressText: "Flux CUDA 런타임 설치 완료",
    detail: FLUX_CUDA_RUNTIME_DIR,
    progressMode: "determinate",
    progressPercent: 1,
    installLogLine: "Flux CUDA/cuDNN 런타임 준비가 완료되었습니다."
  });
}

async function ensureFluxZludaSupportRuntime(options: {
  runtimeDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  const supportDir = join(options.runtimeDir, FLUX_ZLUDA_SUPPORT_RUNTIME_DIR);
  if (await isCurrentFluxZludaSupportRuntime(supportDir)) {
    options.onProgress?.({
      progressText: "Flux ZLUDA 보조 런타임 캐시 사용",
      detail: FLUX_ZLUDA_SUPPORT_RUNTIME_DIR,
      progressMode: "log-only",
      installLogLine: "캐시된 Flux ZLUDA cuRAND 보조 DLL을 사용합니다."
    });
    return supportDir;
  }

  await rm(supportDir, { recursive: true, force: true });
  await mkdir(supportDir, { recursive: true });
  const downloadsDir = join(options.runtimeDir, ".downloads");
  await mkdir(downloadsDir, { recursive: true });

  const cudaManifest = await readJsonUrl(CUDA_REDIST_MANIFEST_URL, options.signal);
  const curandPackage = readNvidiaRedistPackage(cudaManifest, "libcurand", "windows-x86_64");
  if (!curandPackage) {
    throw new Error("NVIDIA CUDA 12.9 런타임 목록에서 cuRAND DLL 패키지를 찾지 못했습니다.");
  }
  const archivePath = await downloadRuntimeArchive({
    ...options,
    downloadsDir,
    entry: curandPackage,
    baseUrl: CUDA_REDIST_BASE_URL,
    label: "Flux ZLUDA cuRAND 보조 런타임"
  });
  extractSelectedZipEntries(archivePath, supportDir, (fileName) => FLUX_ZLUDA_SUPPORT_DLLS.has(fileName));
  if (!(await hasFluxZludaSupportRuntimeFiles(supportDir))) {
    throw new Error("Flux ZLUDA cuRAND 보조 런타임 설치가 완료되지 않았습니다.");
  }
  await writeFile(runtimeMarkerPath(supportDir), `${JSON.stringify({
    cudaManifest: CUDA_REDIST_MANIFEST_URL,
    installedAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
  options.onProgress?.({
    progressText: "Flux ZLUDA 보조 런타임 설치 완료",
    detail: FLUX_ZLUDA_SUPPORT_RUNTIME_DIR,
    progressMode: "determinate",
    progressPercent: 1,
    installLogLine: "Flux ZLUDA cuRAND 보조 DLL 준비가 완료되었습니다."
  });
  return supportDir;
}

async function downloadRuntimeArchive(options: {
  downloadsDir: string;
  entry: { relative_path: string; size?: number };
  baseUrl: string;
  label: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  const url = `${options.baseUrl}/${options.entry.relative_path}`;
  const fileName = basename(options.entry.relative_path);
  const outputPath = join(options.downloadsDir, fileName);
  await downloadToFile({
    url,
    outputPath,
    signal: options.signal,
    progressText: `${options.label} 다운로드 중`,
    label: fileName,
    onProgress: options.onProgress
  });
  return outputPath;
}

async function readJsonUrl(url: string, signal?: AbortSignal): Promise<unknown> {
  throwIfAborted(signal);
  const response = await fetch(url, { signal, headers: { "User-Agent": "manga-gemma-translator" } });
  if (!response.ok) {
    throw new Error(`${url} 요청에 실패했습니다 (${response.status}).`);
  }
  return response.json();
}

function readNvidiaRedistPackage(
  manifest: unknown,
  packageName: string,
  platform: string,
  variant?: string
): NvidiaRedistPackage | null {
  const packageRecord = asJsonRecord(asJsonRecord(manifest)[packageName]);
  const platformValue = packageRecord[platform];
  const value = variant ? asJsonRecord(platformValue)[variant] : platformValue;
  const record = asJsonRecord(value);
  const relativePath = typeof record.relative_path === "string" ? record.relative_path : "";
  if (!relativePath) {
    return null;
  }
  const size = typeof record.size === "number" && Number.isFinite(record.size) ? record.size : undefined;
  return {
    relative_path: relativePath,
    ...(size === undefined ? {} : { size })
  };
}

function asJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function extractSelectedZipEntries(archivePath: string, outputDir: string, shouldExtract: (fileName: string) => boolean): void {
  const zip = new AdmZip(archivePath);
  let extracted = 0;
  for (const item of zip.getEntries()) {
    if (item.isDirectory) {
      continue;
    }
    const fileName = basename(item.entryName);
    if (!fileName || !shouldExtract(fileName)) {
      continue;
    }
    zip.extractEntryTo(item, outputDir, false, true, false, fileName);
    extracted += 1;
  }
  if (extracted === 0) {
    throw new Error(`${basename(archivePath)}에서 필요한 런타임 DLL을 찾지 못했습니다.`);
  }
}

async function isCurrentFluxCudaRuntime(cudaDir: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(runtimeMarkerPath(cudaDir), "utf8")) as { cudnnManifest?: string };
    return marker?.cudnnManifest === CUDNN_REDIST_MANIFEST_URL && await hasFluxCudaRuntimeFiles(cudaDir);
  } catch {
    return false;
  }
}

async function hasFluxCudaRuntimeFiles(cudaDir: string): Promise<boolean> {
  return [...FLUX_CUDA_DLLS, ...FLUX_CUDNN_DLLS].every((fileName) => {
    try {
      return statSync(join(cudaDir, fileName)).size > 0;
    } catch {
      return false;
    }
  });
}

async function isCurrentFluxZludaSupportRuntime(supportDir: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(runtimeMarkerPath(supportDir), "utf8")) as { cudaManifest?: string };
    return marker?.cudaManifest === CUDA_REDIST_MANIFEST_URL && await hasFluxZludaSupportRuntimeFiles(supportDir);
  } catch {
    return false;
  }
}

async function hasFluxZludaSupportRuntimeFiles(supportDir: string): Promise<boolean> {
  return [...FLUX_ZLUDA_SUPPORT_DLLS].every((fileName) => {
    try {
      return statSync(join(supportDir, fileName)).size > 0;
    } catch {
      return false;
    }
  });
}

function runtimeMarkerPath(cudaDir: string): string {
  return join(cudaDir, FLUX_CUDA_RUNTIME_MARKER);
}

function resolveFluxWorkerBackend(backend: FluxRuntimeBackend): FluxWorkerBackend {
  if (backend === "python-cpu") {
    return backend;
  }
  if (backend === "zluda-native" || backend === "python-rocm") {
    return "zluda-native";
  }
  return "cuda-native";
}

function resolveFluxPythonWorkerFile(backend: FluxPythonBackend): string {
  return backend === "python-rocm" ? FLUX_SDCPP_WORKER : FLUX_PYTHON_WORKER;
}

async function ensureFluxPythonWorker(runtimeDir: string, workerFile: string): Promise<string> {
  await mkdir(runtimeDir, { recursive: true });
  const workerPath = join(runtimeDir, workerFile);
  const sourceWorker = findFluxPythonWorkerSource(workerFile);
  if (!sourceWorker) {
    throw new Error(`${workerFile}를 찾지 못했습니다. 앱 런타임 파일을 다시 준비하세요.`);
  }
  if (isExecutableFile(workerPath) && sha256FileSync(workerPath) === sha256FileSync(sourceWorker)) {
    return workerPath;
  }
  await copyFile(sourceWorker, workerPath);
  return workerPath;
}

function findFluxPythonWorkerSource(workerFile: string): string | null {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, "app-runtime", workerFile) : undefined,
    join(process.cwd(), "out", "app-runtime", workerFile),
    join(process.cwd(), "src", "main", "runtime", workerFile)
  ];
  for (const candidate of candidates) {
    if (candidate && isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function resolveCurrentFluxPythonRuntime(options: {
  runtimeDir: string;
  venvPythonPath: string;
  packageDir: string;
  markerPath: string;
  expectedMarker: {
    backend: FluxPythonBackend;
    runtimeInstallBatches: Array<{ id: string; pipArgs: string[] }>;
    buildPackages: string[];
    packages: string[];
    worker: string;
    workerHash: string;
  };
}): Promise<FluxPythonRuntime | null> {
  try {
    if (!isExecutableFile(join(dirname(options.markerPath), options.expectedMarker.worker))) {
      return null;
    }
    const marker = JSON.parse(await readFile(options.markerPath, "utf8")) as Partial<typeof options.expectedMarker> & {
      runtimeMode?: "venv" | "target";
      pythonPath?: string;
      packageDir?: string;
    };
    if (
      marker.backend !== options.expectedMarker.backend ||
      JSON.stringify(marker.runtimeInstallBatches ?? null) !== JSON.stringify(options.expectedMarker.runtimeInstallBatches) ||
      JSON.stringify(marker.buildPackages ?? null) !== JSON.stringify(options.expectedMarker.buildPackages) ||
      JSON.stringify(marker.packages ?? null) !== JSON.stringify(options.expectedMarker.packages) ||
      marker.worker !== options.expectedMarker.worker ||
      marker.workerHash !== options.expectedMarker.workerHash
    ) {
      return null;
    }
    if (marker.runtimeMode !== "target") {
      return null;
    }
    const pythonPath = typeof marker.pythonPath === "string" ? marker.pythonPath : managedFluxBootstrapPythonPath(options.runtimeDir);
    const packageDir = typeof marker.packageDir === "string" ? marker.packageDir : options.packageDir;
    if (!isExecutableFile(pythonPath) || !hasUsablePackageDir(packageDir, options.expectedMarker.backend)) {
      return null;
    }
    if (isAbsolute(pythonPath)) {
      ensureEmbeddedPythonPackagePath(pythonPath, packageDir);
    }
    return {
      mode: "target",
      command: pythonPath,
      executable: pythonPath,
      args: [],
      env: buildTargetPythonEnv(options.runtimeDir, packageDir, options.expectedMarker.backend),
      packageDir
    };
  } catch {
    return null;
  }
}

function pythonExecutablePath(venvDir: string): string {
  return process.platform === "win32" ? join(venvDir, "Scripts", "python.exe") : join(venvDir, "bin", "python");
}

async function findPythonCommand(options: {
  runtimeDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<PythonCommand> {
  const configured = process.env.MANGA_TRANSLATOR_FLUX_PYTHON ?? process.env.MGT_FLUX_PYTHON;
  const candidates: PythonCommand[] = [];
  if (configured) {
    candidates.push({ command: configured, args: [] });
  }
  if (process.platform === "win32") {
    const managedPython = await ensureManagedFluxBootstrapPython(options);
    candidates.push({ command: managedPython, args: [] });
    if (shouldAllowSystemPythonFallback()) {
      candidates.push({ command: "py", args: ["-3"] }, { command: "python", args: [] });
    }
  } else {
    candidates.push({ command: "python3", args: [] }, { command: "python", args: [] });
  }
  for (const candidate of candidates) {
    try {
      await runCommand(candidate.command, [...candidate.args, "--version"], { signal: options.signal });
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("Flux Python 런타임을 만들 Python 3 실행 파일을 찾지 못했습니다. 앱 데이터 Python 준비에 실패했거나 MGT_FLUX_PYTHON 경로가 올바르지 않습니다.");
}

async function ensureManagedFluxBootstrapPython(options: {
  runtimeDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("Flux Python 런타임에는 Python 3.11 이상이 필요합니다.");
  }
  const version = process.env.MANGA_TRANSLATOR_FLUX_PYTHON_VERSION ?? process.env.MGT_FLUX_PYTHON_VERSION ?? FLUX_EMBED_PYTHON_VERSION;
  const pythonUrl =
    process.env.MANGA_TRANSLATOR_FLUX_PYTHON_URL ??
    process.env.MGT_FLUX_PYTHON_URL ??
    `https://www.python.org/ftp/python/${version}/python-${version}-embed-amd64.zip`;
  const getPipUrl = process.env.MANGA_TRANSLATOR_FLUX_GET_PIP_URL ?? process.env.MGT_FLUX_GET_PIP_URL ?? FLUX_GET_PIP_URL;
  const pythonDir = managedFluxBootstrapPythonDir(options.runtimeDir, version);
  const pythonExe = join(pythonDir, "python.exe");
  const markerPath = join(pythonDir, FLUX_BOOTSTRAP_PYTHON_MARKER);
  if (isCurrentManagedFluxBootstrapPython(pythonExe, markerPath, { version, pythonUrl, getPipUrl })) {
    sanitizeStandaloneEmbeddedPythonPathFile(pythonDir);
    return pythonExe;
  }

  await rm(pythonDir, { recursive: true, force: true });
  await mkdir(pythonDir, { recursive: true });
  await mkdir(resolveFluxRuntimeTempDir(options.runtimeDir), { recursive: true });
  const downloadsDir = join(options.runtimeDir, ".downloads", "python");
  await mkdir(downloadsDir, { recursive: true });
  const zipName = basename(new URL(pythonUrl).pathname) || `python-${version}-embed-amd64.zip`;
  const zipPath = join(downloadsDir, zipName);
  const getPipPath = join(downloadsDir, "get-pip.py");

  await downloadToFile({
    url: pythonUrl,
    outputPath: zipPath,
    signal: options.signal,
    progressText: "Flux Python 다운로드 중",
    label: zipName,
    onProgress: options.onProgress
  });
  options.onProgress?.({
    progressText: "Flux Python 압축 해제 중",
    detail: zipName,
    progressMode: "indeterminate",
    installLogLine: "Flux 런타임용 Python을 앱 데이터 폴더에 풀고 있습니다."
  });
  extractZipSafely(zipPath, pythonDir);
  if (!isExecutableFile(pythonExe)) {
    throw new Error("Flux 런타임용 Python 압축을 풀었지만 python.exe를 찾지 못했습니다.");
  }
  sanitizeStandaloneEmbeddedPythonPathFile(pythonDir);

  await downloadToFile({
    url: getPipUrl,
    outputPath: getPipPath,
    signal: options.signal,
    progressText: "Flux pip 다운로드 중",
    label: "get-pip.py",
    onProgress: options.onProgress
  });
  options.onProgress?.({
    progressText: "Flux pip 설치 중",
    detail: `Python ${version}`,
    progressMode: "indeterminate",
    installLogLine: "Flux 런타임용 Python에 pip를 설치합니다."
  });
  await runCommand(pythonExe, [getPipPath, "--no-warn-script-location"], {
    signal: options.signal,
    env: buildBootstrapPythonEnv(options.runtimeDir),
    onLine: (line) => emitPythonInstallLog(options, line)
  });
  await writeFile(markerPath, `${JSON.stringify({ version, pythonUrl, getPipUrl, installedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  return pythonExe;
}

function managedFluxBootstrapPythonDir(runtimeDir: string, version = FLUX_EMBED_PYTHON_VERSION): string {
  return join(runtimeDir, "bootstrap-python", `python-${version}`);
}

function managedFluxBootstrapPythonPath(runtimeDir: string): string {
  return join(managedFluxBootstrapPythonDir(runtimeDir), "python.exe");
}

function isCurrentManagedFluxBootstrapPython(
  pythonExe: string,
  markerPath: string,
  expected: { version: string; pythonUrl: string; getPipUrl: string }
): boolean {
  try {
    if (!isExecutableFile(pythonExe)) {
      return false;
    }
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<typeof expected>;
    return marker.version === expected.version && marker.pythonUrl === expected.pythonUrl && marker.getPipUrl === expected.getPipUrl;
  } catch {
    return false;
  }
}

function shouldAllowSystemPythonFallback(): boolean {
  const explicit = process.env.MANGA_TRANSLATOR_FLUX_ALLOW_SYSTEM_PYTHON ?? process.env.MGT_FLUX_ALLOW_SYSTEM_PYTHON;
  if (explicit !== undefined) {
    return ["1", "true", "yes", "y", "on"].includes(String(explicit).trim().toLowerCase());
  }
  return !isPackagedAppRuntime();
}

function isPackagedAppRuntime(): boolean {
  return Boolean(process.resourcesPath && process.resourcesPath.toLowerCase().includes(`${normalize("\\resources")}`.toLowerCase()));
}

function extractZipSafely(archivePath: string, outputDir: string): void {
  const zip = new AdmZip(archivePath);
  const root = resolve(outputDir);
  for (const item of zip.getEntries()) {
    if (item.isDirectory) {
      continue;
    }
    const entryName = normalize(item.entryName).replace(/^([/\\])+/, "");
    if (!entryName || entryName.startsWith("..") || isAbsolute(entryName)) {
      throw new Error(`${basename(archivePath)}에 안전하지 않은 경로가 포함되어 있습니다: ${item.entryName}`);
    }
    const destination = resolve(root, entryName);
    if (!isPathInside(destination, root)) {
      throw new Error(`${basename(archivePath)}에 안전하지 않은 경로가 포함되어 있습니다: ${item.entryName}`);
    }
    zip.extractEntryTo(item, root, true, true);
  }
}

async function extractLargeZipSafely(archivePath: string, outputDir: string): Promise<void> {
  const root = resolve(outputDir);
  await mkdir(root, { recursive: true });
  const entries: string[] = [];
  await runCommand("tar.exe", ["-tf", archivePath], {
    cwd: root,
    onLine(line) {
      const trimmed = line.trim();
      if (trimmed) {
        entries.push(trimmed);
      }
    }
  });
  validateArchiveEntries(entries, archivePath, root);
  await runCommand("tar.exe", ["-xf", archivePath, "-C", root], { cwd: root });
}

function validateArchiveEntries(entries: string[], archivePath: string, outputRoot: string): void {
  if (entries.length === 0) {
    throw new Error(`${basename(archivePath)} 압축 파일이 비어 있습니다.`);
  }
  for (const rawEntry of entries) {
    const entryName = normalize(rawEntry)
      .replace(/^([/\\])+/, "")
      .replace(/^\.([/\\])+/, "");
    if (!entryName || entryName === ".") {
      continue;
    }
    if (entryName.startsWith("..") || isAbsolute(entryName)) {
      throw new Error(`${basename(archivePath)}에 안전하지 않은 경로가 포함되어 있습니다: ${rawEntry}`);
    }
    const destination = resolve(outputRoot, entryName);
    if (!isPathInside(destination, outputRoot)) {
      throw new Error(`${basename(archivePath)}에 안전하지 않은 경로가 포함되어 있습니다: ${rawEntry}`);
    }
  }
}

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function buildBootstrapPythonEnv(runtimeDir: string): NodeJS.ProcessEnv {
  const tmpDir = resolveFluxRuntimeTempDir(runtimeDir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1",
    PYTHONUNBUFFERED: "1",
    TMP: tmpDir,
    TEMP: tmpDir
  };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  delete env.PYTHONUSERBASE;
  return env;
}

async function initializeWindowsRocmSdk(options: {
  python: PythonCommand;
  packageDir: string;
  runtimeDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<void> {
  const env = buildTargetPythonEnv(options.runtimeDir, options.packageDir, "python-cpu", { requireNativeBuildEnv: false });
  options.onProgress?.({
    progressText: "Flux ROCm SDK 초기화 중",
    detail: "rocm_sdk init",
    progressMode: "indeterminate",
    installLogLine: "ROCm wheel 안의 HIP/CMake 개발 파일을 실제 런타임 폴더로 펼칩니다."
  });
  await runCommand(options.python.command, [...options.python.args, "-m", "rocm_sdk", "init"], {
    cwd: options.packageDir,
    signal: options.signal,
    env,
    onLine: (line) => emitPythonInstallLog({ onProgress: options.onProgress }, line)
  });
  await runCommand(options.python.command, [...options.python.args, "-m", "rocm_sdk", "path", "--cmake"], {
    cwd: options.packageDir,
    signal: options.signal,
    env,
    onLine: (line) => emitPythonInstallLog({ onProgress: options.onProgress }, line)
  });
  options.onProgress?.({
    progressText: "Flux ROCm SDK 초기화 완료",
    detail: "HIP/CMake 개발 파일 확인",
    progressMode: "log-only",
    installLogLine: "ROCm SDK 초기화와 CMake 경로 확인이 완료되었습니다."
  });
}

function buildTargetPythonEnv(
  runtimeDir: string,
  packageDir: string,
  backend: FluxPythonBackend = "python-cpu",
  options: { requireNativeBuildEnv?: boolean } = {}
): NodeJS.ProcessEnv {
  const pathEntries = [
    join(runtimeDir, "bootstrap-python", `python-${FLUX_EMBED_PYTHON_VERSION}`),
    join(runtimeDir, "bootstrap-python", `python-${FLUX_EMBED_PYTHON_VERSION}`, "Scripts"),
    packageDir,
    join(packageDir, "Scripts"),
    join(packageDir, "torch", "lib"),
    join(packageDir, "rocm", "bin"),
    join(packageDir, "rocm_sdk", "bin"),
    join(packageDir, "Library", "bin"),
    join(packageDir, "_rocm_sdk_core", "bin"),
    join(packageDir, "_rocm_sdk_core", "lib", "llvm", "bin"),
    join(packageDir, "_rocm_sdk_devel", "bin"),
    join(packageDir, "_rocm_sdk_devel", "lib", "llvm", "bin"),
    join(packageDir, "_rocm_sdk_libraries_custom", "bin"),
    join(packageDir, "_rocm_sdk_libraries_custom", "bin", "hipblaslt"),
    join(packageDir, "_rocm_sdk_libraries_custom", "bin", "hipblaslt", "library")
  ];
  const env: NodeJS.ProcessEnv = {
    ...buildBootstrapPythonEnv(runtimeDir),
    PYTHONPATH: packageDir,
    PATH: [...pathEntries, process.env.PATH ?? ""].filter(Boolean).join(process.platform === "win32" ? ";" : ":")
  };
  if (backend === "python-rocm") {
    const gpuTargets = resolveAmdGpuTargets();
    const rocmPaths = resolveWindowsRocmSdkPaths(packageDir);
    const nativeBuildEnv = resolveWindowsNativeBuildEnv();
    if (!nativeBuildEnv && options.requireNativeBuildEnv) {
      throw new Error(formatWindowsNativeBuildToolsMissingMessage());
    }
    const rcCompiler = stageWindowsResourceCompiler(runtimeDir, resolveWindowsResourceCompiler(rocmPaths, nativeBuildEnv));
    const runtimeLibraryPaths = nativeBuildEnv ? resolveWindowsRuntimeLibraryPaths(nativeBuildEnv.libPaths) : [];
    const stagedRuntimeLibraryPaths = stageWindowsRuntimeLibraries(runtimeDir, runtimeLibraryPaths);
    const runtimeLibraryCmakeValue = stagedRuntimeLibraryPaths.map((item) => quoteShellToken(toCmakePath(item))).join(" ");
    const runtimeLibraryLdFlags = stagedRuntimeLibraryPaths.map((item) => quoteShellToken(toCmakePath(item))).join(" ");
    const rocmCmakePrefixList = rocmPaths.cmakePrefixPaths.map(toCmakePath).join(";");
    const hipCompilerFlags = [
      `--rocm-device-lib-path=${toCmakePath(rocmPaths.deviceLibPath)}`,
      `--hip-device-lib-path=${toCmakePath(rocmPaths.deviceLibPath)}`,
      `--hip-path=${toCmakePath(rocmPaths.hipRoot)}`
    ].map(quoteShellToken).join(" ");
    const cmakeArgs = [
      env.CMAKE_ARGS,
      `-DCMAKE_C_COMPILER:FILEPATH=${toCmakePath(rocmPaths.clang)}`,
      `-DCMAKE_CXX_COMPILER:FILEPATH=${toCmakePath(rocmPaths.clangxx)}`,
      rcCompiler ? `-DCMAKE_RC_COMPILER:FILEPATH=${toCmakePath(rcCompiler)}` : "",
      existsSync(rocmPaths.llvmMt) ? `-DCMAKE_MT:FILEPATH=${toCmakePath(rocmPaths.llvmMt)}` : "",
      nativeBuildEnv?.sdkVersion ? `-DCMAKE_SYSTEM_VERSION=${nativeBuildEnv.sdkVersion}` : "",
      nativeBuildEnv?.sdkVersion ? `-DCMAKE_VS_WINDOWS_TARGET_PLATFORM_VERSION=${nativeBuildEnv.sdkVersion}` : "",
      `-DCMAKE_C_COMPILER_TARGET=${WINDOWS_MSVC_COMPILER_TARGET}`,
      `-DCMAKE_CXX_COMPILER_TARGET=${WINDOWS_MSVC_COMPILER_TARGET}`,
      "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL",
      runtimeLibraryCmakeValue ? quoteCmakeArg(`-DCMAKE_C_STANDARD_LIBRARIES:STRING=${runtimeLibraryCmakeValue}`) : "",
      runtimeLibraryCmakeValue ? quoteCmakeArg(`-DCMAKE_CXX_STANDARD_LIBRARIES:STRING=${runtimeLibraryCmakeValue}`) : "",
      quoteCmakeArg(`-DCMAKE_PREFIX_PATH:STRING=${rocmCmakePrefixList}`),
      quoteCmakeArg(`-Dhip_DIR:PATH=${toCmakePath(rocmPaths.hipCmakeDir)}`),
      quoteCmakeArg(`-DHIP_PATH:PATH=${toCmakePath(rocmPaths.hipRoot)}`),
      quoteCmakeArg(`-DROCM_PATH:PATH=${toCmakePath(rocmPaths.rocmRoot)}`),
      quoteCmakeArg(`-DHIP_DEVICE_LIB_PATH:PATH=${toCmakePath(rocmPaths.deviceLibPath)}`),
      quoteCmakeArg(`-DROCM_DEVICE_LIB_PATH:PATH=${toCmakePath(rocmPaths.deviceLibPath)}`),
      quoteCmakeArg(`-DCMAKE_HIP_FLAGS:STRING=${hipCompilerFlags}`),
      "-DHIP_PLATFORM=amd",
      "-DCMAKE_TRY_COMPILE_CONFIGURATION=Release",
      "-DSD_HIPBLAS=ON",
      "-DGGML_OPENMP=OFF",
      "-DCMAKE_BUILD_TYPE=Release",
      "-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON",
      "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
      gpuTargets ? `-DGPU_TARGETS=${gpuTargets}` : "",
      gpuTargets ? `-DAMDGPU_TARGETS=${gpuTargets}` : ""
    ].filter(Boolean);
    env.CMAKE_ARGS = cmakeArgs.join(" ");
    env.CFLAGS = mergeWords(env.CFLAGS, `--target=${WINDOWS_MSVC_COMPILER_TARGET}`);
    env.CXXFLAGS = mergeWords(env.CXXFLAGS, `--target=${WINDOWS_MSVC_COMPILER_TARGET}`, hipCompilerFlags);
    env.LDFLAGS = mergeWords(env.LDFLAGS, runtimeLibraryLdFlags);
    env.FORCE_CMAKE = "1";
    env.CMAKE_GENERATOR = env.CMAKE_GENERATOR || "Ninja";
    if (nativeBuildEnv) {
      env.PATH = mergePathList(nativeBuildEnv.pathEntries, env.PATH);
      env.INCLUDE = mergePathList(nativeBuildEnv.includePaths);
      env.LIB = mergePathList(join(runtimeDir, "native-libs"), nativeBuildEnv.libPaths);
      env.LIBPATH = mergePathList(join(runtimeDir, "native-libs"), nativeBuildEnv.libPaths);
    }
    env.CC = env.CC || rocmPaths.clang;
    env.CXX = env.CXX || rocmPaths.clangxx;
    if (rcCompiler) {
      env.RC = env.RC || rcCompiler;
    }
    env.ROCM_PATH = env.ROCM_PATH || rocmPaths.rocmRoot;
    env.HIP_PATH = env.HIP_PATH || rocmPaths.hipRoot;
    env.HIP_DEVICE_LIB_PATH = env.HIP_DEVICE_LIB_PATH || rocmPaths.deviceLibPath;
    env.ROCM_DEVICE_LIB_PATH = env.ROCM_DEVICE_LIB_PATH || rocmPaths.deviceLibPath;
    env.CMAKE_PREFIX_PATH = mergePathList(env.CMAKE_PREFIX_PATH, rocmPaths.cmakePrefixPaths);
    if (gpuTargets) {
      env.GPU_TARGETS = env.GPU_TARGETS || gpuTargets;
      env.AMDGPU_TARGETS = env.AMDGPU_TARGETS || gpuTargets;
    }
  }
  return env;
}

function resolveWindowsRocmSdkPaths(packageDir: string): {
  coreRoot: string;
  develRoot: string;
  librariesRoot: string;
  rocmRoot: string;
  hipRoot: string;
  hipCmakeDir: string;
  cmakePrefixPaths: string[];
  clang: string;
  clangxx: string;
  llvmRc: string;
  llvmMt: string;
  deviceLibPath: string;
} {
  const coreRoot = join(packageDir, "_rocm_sdk_core");
  const develRoot = join(packageDir, "_rocm_sdk_devel");
  const librariesRoot = join(packageDir, "_rocm_sdk_libraries_custom");
  const llvmBin = join(coreRoot, "lib", "llvm", "bin");
  const deviceLibPath = resolveRocmDeviceLibPath(packageDir, coreRoot, develRoot);
  const hipCmakeDir = resolveCmakePackageDir(packageDir, "hip", [
    join(develRoot, "lib", "cmake", "hip"),
    join(coreRoot, "lib", "cmake", "hip"),
    join(librariesRoot, "lib", "cmake", "hip"),
    join(packageDir, "lib", "cmake", "hip")
  ]);
  const hipRoot = resolveRocmRootForCmakePackage(hipCmakeDir, develRoot);
  const cmakePrefixPaths = uniqueExistingDirs([
    coreRoot,
    develRoot,
    librariesRoot,
    join(coreRoot, "lib", "cmake"),
    join(develRoot, "lib", "cmake"),
    join(librariesRoot, "lib", "cmake"),
    hipRoot,
    hipCmakeDir
  ]);
  return {
    coreRoot,
    develRoot,
    librariesRoot,
    rocmRoot: develRoot,
    hipRoot,
    hipCmakeDir,
    cmakePrefixPaths,
    clang: join(llvmBin, "clang.exe"),
    clangxx: join(llvmBin, "clang++.exe"),
    llvmRc: join(llvmBin, "llvm-rc.exe"),
    llvmMt: join(llvmBin, "llvm-mt.exe"),
    deviceLibPath
  };
}

function resolveRocmDeviceLibPath(packageDir: string, coreRoot: string, develRoot: string): string {
  const candidates = [
    join(coreRoot, "lib", "llvm", "amdgcn", "bitcode"),
    join(develRoot, "lib", "llvm", "amdgcn", "bitcode"),
    join(packageDir, "lib", "llvm", "amdgcn", "bitcode")
  ];
  for (const candidate of candidates) {
    if (fileExists(join(candidate, "ocml.bc"))) {
      return candidate;
    }
  }
  const found = findFirstFileRecursive(packageDir, new Set(["ocml.bc"]), 8);
  if (found) {
    return dirname(found);
  }
  return candidates[0];
}

function resolveWindowsResourceCompiler(
  rocmPaths: { llvmRc: string },
  nativeBuildEnv: WindowsNativeBuildEnv | null
): string | null {
  if (fileExists(rocmPaths.llvmRc)) {
    return rocmPaths.llvmRc;
  }
  return nativeBuildEnv ? findFileInPathList(nativeBuildEnv.pathEntries, "rc.exe") : null;
}

function stageWindowsResourceCompiler(runtimeDir: string, rcCompiler: string | null): string | null {
  if (!rcCompiler) {
    return rcCompiler;
  }
  const stagedDir = join(runtimeDir, "native-tools");
  const stagedPath = join(stagedDir, "rc.exe");
  mkdirSync(stagedDir, { recursive: true });
  copyFileSync(rcCompiler, stagedPath);
  return stagedPath;
}

function stageWindowsRuntimeLibraries(runtimeDir: string, libraryPaths: string[]): string[] {
  if (!libraryPaths.length) {
    return [];
  }
  const stagedDir = join(runtimeDir, "native-libs");
  mkdirSync(stagedDir, { recursive: true });
  return libraryPaths.map((libraryPath) => {
    const stagedPath = join(stagedDir, basename(libraryPath));
    copyFileSync(libraryPath, stagedPath);
    return stagedPath;
  });
}

function resolveCmakePackageDir(packageDir: string, packageName: string, candidates: string[]): string {
  const configNames = [
    `${packageName}-config.cmake`,
    `${packageName}Config.cmake`
  ];
  for (const candidate of candidates) {
    if (configNames.some((name) => fileExists(join(candidate, name)))) {
      return candidate;
    }
  }
  const found = findFirstFileRecursive(packageDir, new Set(configNames.map((name) => name.toLowerCase())), 8);
  if (found) {
    return dirname(found);
  }
  throw new Error(formatMissingCmakePackageMessage(packageDir, packageName, configNames, candidates));
}

function resolveRocmRootForCmakePackage(cmakeDir: string, fallbackRoot: string): string {
  const normalized = resolve(cmakeDir).replace(/\\/g, "/");
  const markerIndex = normalized.toLowerCase().lastIndexOf("/lib/cmake");
  return markerIndex > 0 ? normalized.slice(0, markerIndex) : fallbackRoot;
}

function formatMissingCmakePackageMessage(
  packageDir: string,
  packageName: string,
  configNames: string[],
  candidates: string[]
): string {
  return [
    `ROCm CMake package "${packageName}" was not found after ROCm SDK initialization.`,
    `Expected one of: ${configNames.join(", ")}`,
    "Candidate directories:",
    ...candidates.map((item) => `  - ${item} ${directoryExists(item) ? "(exists)" : "(missing)"}`),
    formatRocmTreeSummary(packageDir)
  ].join("\n");
}

function formatRocmTreeSummary(packageDir: string): string {
  const roots = [
    packageDir,
    join(packageDir, "_rocm_sdk_core"),
    join(packageDir, "_rocm_sdk_devel"),
    join(packageDir, "_rocm_sdk_libraries_custom"),
    join(packageDir, "rocm"),
    join(packageDir, "rocm_sdk")
  ];
  const lines = ["ROCm package tree summary:"];
  for (const root of roots) {
    if (!directoryExists(root)) {
      lines.push(`  - ${root}: missing`);
      continue;
    }
    lines.push(`  - ${root}: exists`);
    const entries = safeReadDir(root).slice(0, 30).map((entry) => entry.name).join(", ");
    if (entries) {
      lines.push(`    entries: ${entries}`);
    }
  }
  const cmakeHits = findFilesRecursive(packageDir, (entry) => {
    const lower = entry.name.toLowerCase();
    return entry.isFile() && (lower.includes("hip") || lower.includes("rocm")) && lower.endsWith(".cmake");
  }, 9, 60);
  if (cmakeHits.length) {
    lines.push("Nearby ROCm/HIP CMake files:");
    for (const hit of cmakeHits) {
      lines.push(`  - ${hit}`);
    }
  } else {
    lines.push("Nearby ROCm/HIP CMake files: none found");
  }
  return lines.join("\n");
}

function safeReadDir(dir: string): import("node:fs").Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function findFirstFileRecursive(root: string, lowerCaseNames: Set<string>, maxDepth: number): string | null {
  if (!directoryExists(root)) {
    return null;
  }
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(current.dir, entry.name);
      if (entry.isFile() && lowerCaseNames.has(entry.name.toLowerCase())) {
        return fullPath;
      }
      if (entry.isDirectory() && current.depth < maxDepth && !["__pycache__", ".git"].includes(entry.name)) {
        queue.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }
  }
  return null;
}

function findFilesRecursive(
  root: string,
  predicate: (entry: import("node:fs").Dirent, fullPath: string) => boolean,
  maxDepth: number,
  limit: number
): string[] {
  if (!directoryExists(root)) {
    return [];
  }
  const results: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length && results.length < limit) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(current.dir, entry.name);
      if (predicate(entry, fullPath)) {
        results.push(fullPath);
        if (results.length >= limit) {
          break;
        }
      }
      if (entry.isDirectory() && current.depth < maxDepth && !["__pycache__", ".git"].includes(entry.name)) {
        queue.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }
  }
  return results;
}

export function resolveWindowsNativeBuildEnv(): WindowsNativeBuildEnv | null {
  if (process.platform !== "win32") {
    return null;
  }
  const sdk = resolveWindowsSdkLayout();
  const msvc = resolveMsvcToolsLayout();
  const envLibPaths = splitPathList(process.env.LIB).filter((item) => !isX86WindowsLibraryPath(item));
  const envIncludePaths = splitPathList(process.env.INCLUDE);
  const envPathEntries = splitPathList(process.env.PATH);
  const libPaths = uniqueExistingDirs([
    ...(sdk ? [sdk.umLibPath, sdk.ucrtLibPath] : []),
    ...(msvc ? [msvc.libPath] : []),
    ...envLibPaths
  ]);
  const includePaths = uniqueExistingDirs([
    ...(sdk ? sdk.includePaths : []),
    ...(msvc ? [msvc.includePath] : []),
    ...envIncludePaths
  ]);
  const pathEntries = uniqueExistingDirs([
    ...(sdk?.binPath ? [sdk.binPath] : []),
    ...(msvc?.binPath ? [msvc.binPath] : []),
    ...envPathEntries
  ]);
  const hasWindowsSdkLibs = ["kernel32.lib", "user32.lib", "gdi32.lib", "shell32.lib", "ole32.lib", "uuid.lib", "advapi32.lib"]
    .every((file) => pathListContainsFile(libPaths, file));
  const hasUcrtLibs = pathListContainsFile(libPaths, "ucrt.lib");
  const hasMsvcLibs =
    pathListContainsFile(libPaths, "oldnames.lib") &&
    pathListContainsFile(libPaths, "vcruntime.lib") &&
    (pathListContainsFile(libPaths, "msvcrt.lib") || pathListContainsFile(libPaths, "msvcrtd.lib"));
  if (!hasWindowsSdkLibs || !hasUcrtLibs || !hasMsvcLibs) {
    return null;
  }
  return {
    sdkVersion: sdk?.version,
    pathEntries,
    includePaths,
    libPaths
  };
}

function resolveWindowsRuntimeLibraryPaths(libPaths: string[]): string[] {
  return [...WINDOWS_DYNAMIC_RUNTIME_LIB_NAMES, ...WINDOWS_SYSTEM_IMPORT_LIB_NAMES].map((fileName) => {
    const match = findFileInPathList(libPaths, fileName);
    if (!match) {
      throw new Error(`Required Windows/MSVC runtime library was not found: ${fileName}`);
    }
    if (isX86WindowsLibraryPath(match)) {
      throw new Error(`Resolved a 32-bit Windows/MSVC runtime library while building x64: ${match}`);
    }
    return match;
  });
}

function isX86WindowsLibraryPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return /\/lib\/x86(\/|$)/.test(normalized) || /\/(um|ucrt)\/x86(\/|$)/.test(normalized);
}

function formatWindowsNativeBuildToolsMissingMessage(): string {
  return [
    "Flux ROCm 런타임을 빌드하려면 Windows SDK와 Microsoft C++ Build Tools가 필요합니다.",
    "현재 Windows import library(kernel32.lib 등) 또는 MSVC library(oldnames.lib/msvcrt.lib)를 찾지 못했습니다.",
    'Visual Studio 2022 Build Tools에서 "Desktop development with C++"와 Windows 10/11 SDK를 설치한 뒤 다시 시도하세요.',
    "이미 설치되어 있다면 Developer Command Prompt에서 실행하거나 MANGA_TRANSLATOR_WINDOWS_KITS_ROOT / MANGA_TRANSLATOR_MSVC_TOOLS_ROOT 환경변수로 위치를 지정할 수 있습니다."
  ].join(" ");
}

function resolveWindowsSdkLayout(): {
  root: string;
  version: string;
  umLibPath: string;
  ucrtLibPath: string;
  includePaths: string[];
  binPath?: string;
} | null {
  const roots = uniquePaths([
    process.env.MANGA_TRANSLATOR_WINDOWS_KITS_ROOT,
    process.env.MGT_WINDOWS_KITS_ROOT,
    process.env.WindowsSdkDir,
    process.env.UniversalCRTSdkDir,
    process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"] as string, "Windows Kits", "10") : "",
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Windows Kits", "10") : ""
  ]);
  for (const root of roots) {
    const libRoot = join(root, "Lib");
    const includeRoot = join(root, "Include");
    const versions = readChildDirectories(libRoot).sort(compareVersionDesc);
    for (const version of versions) {
      const umLibPath = join(libRoot, version, "um", "x64");
      const ucrtLibPath = join(libRoot, version, "ucrt", "x64");
      if (!fileExists(join(umLibPath, "kernel32.lib")) || !directoryExists(ucrtLibPath)) {
        continue;
      }
      const includePaths = ["ucrt", "shared", "um", "winrt", "cppwinrt"]
        .map((name) => join(includeRoot, version, name))
        .filter(directoryExists);
      const binPath = join(root, "bin", version, "x64");
      return {
        root,
        version,
        umLibPath,
        ucrtLibPath,
        includePaths,
        binPath: directoryExists(binPath) ? binPath : undefined
      };
    }
  }
  return null;
}

function resolveMsvcToolsLayout(): {
  root: string;
  version?: string;
  libPath: string;
  includePath: string;
  binPath?: string;
} | null {
  const directRoots = uniquePaths([
    process.env.MANGA_TRANSLATOR_MSVC_TOOLS_ROOT,
    process.env.MGT_MSVC_TOOLS_ROOT,
    process.env.VCToolsInstallDir
  ]);
  for (const root of directRoots) {
    const layout = toMsvcToolsLayout(root);
    if (layout) {
      return layout;
    }
  }

  const versionRoots: string[] = [];
  if (process.env.VCINSTALLDIR) {
    versionRoots.push(join(process.env.VCINSTALLDIR, "Tools", "MSVC"));
  }
  const programFiles = process.env.ProgramFiles;
  if (programFiles) {
    for (const year of ["2022", "2019"]) {
      for (const edition of ["BuildTools", "Community", "Professional", "Enterprise"]) {
        versionRoots.push(join(programFiles, "Microsoft Visual Studio", year, edition, "VC", "Tools", "MSVC"));
      }
    }
  }
  for (const versionRoot of uniquePaths(versionRoots)) {
    const versions = readChildDirectories(versionRoot).sort(compareVersionDesc);
    for (const version of versions) {
      const layout = toMsvcToolsLayout(join(versionRoot, version), version);
      if (layout) {
        return layout;
      }
    }
  }
  return null;
}

function toMsvcToolsLayout(root: string, version?: string): {
  root: string;
  version?: string;
  libPath: string;
  includePath: string;
  binPath?: string;
} | null {
  const libPath = join(root, "lib", "x64");
  const includePath = join(root, "include");
  if (!fileExists(join(libPath, "oldnames.lib")) || !directoryExists(includePath)) {
    return null;
  }
  const binPath = join(root, "bin", "Hostx64", "x64");
  return {
    root,
    version,
    libPath,
    includePath,
    binPath: directoryExists(binPath) ? binPath : undefined
  };
}

function splitPathList(value?: string): string[] {
  return (value ?? "")
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergePathList(...values: Array<string | string[] | null | undefined>): string {
  const entries: string[] = [];
  for (const value of values) {
    if (!value) {
      continue;
    }
    if (Array.isArray(value)) {
      entries.push(...value);
    } else {
      entries.push(...splitPathList(value));
    }
  }
  return uniquePaths(entries).join(delimiter);
}

function mergeWords(...values: Array<string | string[] | null | undefined>): string {
  return values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

function quoteCmakeArg(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function quoteShellToken(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function uniqueExistingDirs(paths: string[]): string[] {
  return uniquePaths(paths).filter(directoryExists);
}

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawPath of paths) {
    const value = rawPath?.trim();
    if (!value) {
      continue;
    }
    const normalized = resolve(value);
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function readChildDirectories(root: string): string[] {
  try {
    return readdirSync(root)
      .map((name) => ({ name, path: join(root, name) }))
      .filter((entry) => directoryExists(entry.path))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function compareVersionDesc(left: string, right: string): number {
  return compareVersionStrings(right, left);
}

function compareVersionStrings(left: string, right: string): number {
  const leftParts = left.split(/[^\d]+/).filter(Boolean).map(Number);
  const rightParts = right.split(/[^\d]+/).filter(Boolean).map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return left.localeCompare(right);
}

function pathListContainsFile(paths: string[], fileName: string): boolean {
  return paths.some((dir) => fileExists(join(dir, fileName)));
}

function findFileInPathList(paths: string[], fileName: string): string | null {
  for (const dir of paths) {
    const candidate = join(dir, fileName);
    if (fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

function directoryExists(pathValue: string): boolean {
  try {
    return statSync(pathValue).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(pathValue: string): boolean {
  try {
    return statSync(pathValue).isFile();
  } catch {
    return false;
  }
}

function toCmakePath(pathValue: string): string {
  return resolve(pathValue).replace(/\\/g, "/");
}

function resolveAmdGpuTargets(): string | null {
  const value =
    process.env.MANGA_TRANSLATOR_AMDGPU_TARGETS ??
    process.env.MGT_AMDGPU_TARGETS ??
    process.env.AMDGPU_TARGETS ??
    process.env.GPU_TARGETS ??
    "";
  const normalized = value
    .split(/[,\s;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .join(";");
  return normalized || DEFAULT_AMD_GPU_TARGETS.join(";");
}

function ensureEmbeddedPythonPackagePath(pythonPath: string, packageDir: string): void {
  if (basename(pythonPath).toLowerCase() !== "python.exe") {
    return;
  }
  const pythonDir = dirname(resolve(pythonPath));
  let pthName: string | undefined;
  try {
    pthName = readdirSync(pythonDir).find((name) => /^python\d+._pth$/i.test(name));
  } catch {
    return;
  }
  if (!pthName) {
    return;
  }
  const pthPath = join(pythonDir, pthName);
  try {
    const normalizedPackageDir = resolve(packageDir);
    const text = readFileSync(pthPath, "utf8");
    const nextLines = text
      .split(/\r?\n/)
      .filter((line) => !isManagedFluxPackagePathLine(line, pythonDir, normalizedPackageDir))
      .map((line) => line.trim() === "#import site" ? "import site" : line);
    const importSiteIndex = nextLines.findIndex((line) => line.trim() === "import site");
    if (importSiteIndex === -1) {
      nextLines.push(normalizedPackageDir, "import site");
    } else {
      nextLines.splice(importSiteIndex, 0, normalizedPackageDir);
    }
    const nextText = `${nextLines.filter((line, index, array) => index < array.length - 1 || line.trim()).join("\n")}\n`;
    if (nextText !== text) {
      writeFileSync(pthPath, nextText, "utf8");
    }
  } catch {
    // If the ._pth file cannot be updated, PYTHONPATH still helps non-isolated Python builds.
  }
}

function sanitizeStandaloneEmbeddedPythonPathFile(outputDir: string): void {
  let pthName: string | undefined;
  try {
    pthName = readdirSync(outputDir).find((name) => /^python\d+._pth$/i.test(name));
  } catch {
    return;
  }
  if (!pthName) {
    return;
  }
  const pthPath = join(outputDir, pthName);
  try {
    const text = readFileSync(pthPath, "utf8");
    const sanitized: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "#import site" || trimmed === "import site") {
        continue;
      }
      if (isManagedFluxPackagePathLine(trimmed, outputDir)) {
        continue;
      }
      if (!trimmed && sanitized[sanitized.length - 1] === "") {
        continue;
      }
      sanitized.push(line);
    }
    const nextText = buildStandaloneEmbeddedPythonPathText(outputDir, pthName, sanitized);
    if (nextText !== text) {
      writeFileSync(pthPath, nextText, "utf8");
    }
  } catch {
    // The runtime can still fail with a clear pip/import error later.
  }
}

function buildStandaloneEmbeddedPythonPathText(outputDir: string, pthName: string, lines: string[]): string {
  const normalizedLines = lines
    .map((line) => line.trim())
    .filter((line) => line && line !== "import site" && line !== "#import site");
  const pthEntries: string[] = [];
  const addEntry = (entry: string) => {
    if (!entry || pthEntries.some((line) => line.toLowerCase() === entry.toLowerCase())) {
      return;
    }
    pthEntries.push(entry);
  };

  const stdlibZipName = pthName.replace(/._pth$/i, ".zip");
  if (existsSync(join(outputDir, stdlibZipName))) {
    addEntry(stdlibZipName);
  }
  addEntry(".");
  for (const line of normalizedLines) {
    addEntry(line);
  }
  addEntry("import site");
  return `${pthEntries.join("\n")}\n`;
}

function isManagedFluxPackagePathLine(line: string, pythonDir: string, packageDir?: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed === "." || trimmed === "import site" || trimmed.startsWith("#")) {
    return false;
  }
  try {
    const resolvedLine = resolve(pythonDir, trimmed);
    if (packageDir && isPathInside(resolvedLine, packageDir)) {
      return true;
    }
    const baseName = basename(resolvedLine).toLowerCase();
    if (!baseName.startsWith("python-packages")) {
      return false;
    }
    const normalized = resolvedLine.replace(/\\/g, "/").toLowerCase();
    return normalized.includes("/mgt-flux-python-") || normalized.includes("/models/inpainting/");
  } catch {
    return false;
  }
}

function hasUsablePackageDir(packageDir: string, backend: FluxPythonBackend): boolean {
  const requiredModules = backend === "python-rocm"
    ? ["stable_diffusion_cpp", "PIL"]
    : ["torch", "diffusers", "transformers"];
  return requiredModules.every((name) => existsSync(join(packageDir, name)));
}

function resolvePythonRuntimeInstallBatches(backend: FluxPythonBackend): FluxPythonInstallBatch[] {
  if (backend === "python-rocm" && process.platform === "win32") {
    const rocmPackageUrls = resolveListEnv("MANGA_TRANSLATOR_FLUX_ROCM_PACKAGE_URLS", "MGT_FLUX_ROCM_PACKAGE_URLS") ??
      defaultWindowsRocmPackageUrls();
    return [
      {
        id: `windows-rocm-runtime-${FLUX_ROCM_WINDOWS_VERSION}-sdcpp`,
        progressText: "Flux ROCm/HIP 런타임 설치 중",
        detail: `ROCm ${FLUX_ROCM_WINDOWS_VERSION}`,
        installLogLine: "AMD Windows ROCm SDK를 stable-diffusion.cpp 빌드용으로 준비합니다.",
        pipArgs: rocmPackageUrls
      }
    ];
  }

  if (backend === "python-rocm") {
    return [];
  }

  const torchIndexUrl = process.env.MANGA_TRANSLATOR_FLUX_CPU_TORCH_INDEX_URL ?? process.env.MGT_FLUX_CPU_TORCH_INDEX_URL ?? FLUX_CPU_TORCH_INDEX_URL;
  return [
    {
      id: `cpu-index-${torchIndexUrl}`,
      progressText: "Flux CPU PyTorch 설치 중",
      detail: torchIndexUrl,
      installLogLine: `PyTorch 설치 인덱스: ${torchIndexUrl}`,
      pipArgs: ["--index-url", torchIndexUrl, "torch", "torchvision"]
    }
  ];
}

function defaultWindowsRocmPackageUrls(): string[] {
  const base = windowsRocmBaseUrl();
  const version = FLUX_ROCM_WINDOWS_VERSION;
  return [
    `${base}/rocm_sdk_core-${version}-py3-none-win_amd64.whl`,
    `${base}/rocm_sdk_devel-${version}-py3-none-win_amd64.whl`,
    `${base}/rocm_sdk_libraries_custom-${version}-py3-none-win_amd64.whl`,
    `${base}/rocm-${version}.tar.gz`
  ];
}

function windowsRocmBaseUrl(): string {
  return process.env.MANGA_TRANSLATOR_FLUX_ROCM_WINDOWS_BASE_URL ??
    process.env.MGT_FLUX_ROCM_WINDOWS_BASE_URL ??
    `https://repo.radeon.com/rocm/windows/rocm-rel-${FLUX_ROCM_WINDOWS_VERSION}`;
}

function resolveFluxRocmPrebuiltRuntimeUrl(): string {
  return process.env.MANGA_TRANSLATOR_FLUX_ROCM_RUNTIME_ARCHIVE_URL ??
    process.env.MGT_FLUX_ROCM_RUNTIME_ARCHIVE_URL ??
    FLUX_ROCM_PREBUILT_RUNTIME_URL;
}

function shouldUsePrebuiltFluxRocmRuntime(): boolean {
  const value = process.env.MANGA_TRANSLATOR_FLUX_ROCM_USE_PREBUILT ??
    process.env.MGT_FLUX_ROCM_USE_PREBUILT;
  if (value === undefined) {
    return true;
  }
  return !["0", "false", "no", "n", "off"].includes(String(value).trim().toLowerCase());
}

function shouldAllowFluxRocmSourceBuildFallback(): boolean {
  const value = process.env.MANGA_TRANSLATOR_FLUX_ROCM_ALLOW_SOURCE_BUILD ??
    process.env.MGT_FLUX_ROCM_ALLOW_SOURCE_BUILD;
  return ["1", "true", "yes", "y", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function resolveListEnv(primary: string, secondary: string): string[] | null {
  const value = process.env[primary] ?? process.env[secondary];
  if (!value) {
    return null;
  }
  const items = value
    .split(/[\r\n, ]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

function resolvePythonFluxPackages(backend: FluxPythonBackend): string[] {
  if (backend === "python-rocm") {
    return [
      "--no-build-isolation",
      "--no-cache-dir",
      "--force-reinstall",
      "stable-diffusion-cpp-python",
      "huggingface_hub>=0.36.0",
      "pillow>=10.0.0"
    ];
  }
  return [
    "diffusers>=0.36.0",
    "gguf>=0.17.0",
    "transformers>=4.56.0",
    "accelerate>=1.10.0",
    "safetensors>=0.6.0",
    "huggingface_hub>=0.36.0",
    "pillow>=10.0.0",
    "sentencepiece>=0.2.0",
    "protobuf>=4.25.0"
  ];
}

function resolvePythonBuildPackages(backend: FluxPythonBackend): string[] {
  if (backend !== "python-rocm") {
    return [];
  }
  return [
    "scikit-build-core>=0.11.0",
    "cmake>=3.29.0",
    "ninja>=1.11.1",
    "packaging>=24.0",
    "setuptools>=69.0.0",
    "wheel>=0.43.0"
  ];
}

function resolveFluxPythonMode(): string {
  const normalized = String(process.env.MANGA_TRANSLATOR_FLUX_PYTHON_MODE ?? process.env.MGT_FLUX_PYTHON_MODE ?? "")
    .trim()
    .toLowerCase();
  return normalized === "flux-fill" ? "flux-fill" : FLUX_PYTHON_DEFAULT_MODE;
}

async function verifyFluxPythonRuntime(
  pythonRuntime: FluxPythonRuntime,
  backend: FluxPythonBackend,
  signal?: AbortSignal
): Promise<void> {
  const verifyScript = backend === "python-rocm"
    ? [
        "import importlib",
        "for name in ['stable_diffusion_cpp','PIL','huggingface_hub']:",
        "    importlib.import_module(name)",
        "print('ok')"
      ].join("\n")
    : [
        "import importlib, torch",
        "for name in ['diffusers','gguf','transformers','accelerate','safetensors','PIL','torchvision','sentencepiece','google.protobuf']:",
        "    importlib.import_module(name)",
        "print('ok')"
      ].join("\n");
  await runCommand(pythonRuntime.executable, [...pythonRuntime.args, "-c", verifyScript], {
    signal,
    env: pythonRuntime.env
  });
}

async function ensureFluxPythonModelCache(options: {
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
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as { modelId?: string; ignorePatterns?: string[] };
    if (marker.modelId === options.modelId && JSON.stringify(marker.ignorePatterns ?? []) === JSON.stringify(ignorePatterns)) {
      options.onProgress?.({
        progressText: "Flux Diffusers 모델 캐시 사용",
        detail: options.modelId,
        progressMode: "log-only",
        installLogLine: `캐시된 Diffusers Flux 모델을 사용합니다: ${options.modelId}`
      });
      return;
    }
  } catch {
    // Model cache marker is best-effort; snapshot_download below is idempotent.
  }

  await mkdir(options.modelDir, { recursive: true });
  if (ignorePatterns.length > 0) {
    await rm(resolveHuggingFaceRepoCacheDir(options.modelDir, options.modelId), { recursive: true, force: true });
  }
  options.onProgress?.({
    progressText: "Flux Diffusers 모델 준비 중",
    detail: ignorePatterns.length > 0 ? `${options.modelId} · transformer 제외` : options.modelId,
    progressMode: "indeterminate",
    installLogLine:
      ignorePatterns.length > 0
        ? `Diffusers Flux 모델 캐시를 확인합니다: ${options.modelId} (GGUF transformer 사용, 원본 transformer 제외)`
        : `Diffusers Flux 모델 캐시를 확인합니다: ${options.modelId}`
  });
  const downloadScript = [
    "from huggingface_hub import snapshot_download",
    "import json, sys",
    "ignore_patterns = json.loads(sys.argv[3])",
    "snapshot_download(repo_id=sys.argv[1], cache_dir=sys.argv[2], resume_download=True, ignore_patterns=ignore_patterns or None)"
  ].join("\n");
  await runCommand(options.pythonRuntime.executable, [
    ...options.pythonRuntime.args,
    "-c",
    downloadScript,
    options.modelId,
    options.modelDir,
    JSON.stringify(ignorePatterns)
  ], {
    signal: options.signal,
    env: {
      ...options.pythonRuntime.env,
      HF_HOME: options.modelDir,
      HUGGINGFACE_HUB_CACHE: join(options.modelDir, "hub")
    },
    onLine: (line) =>
      options.onProgress?.({
        progressText: "Flux Diffusers 모델 준비 중",
        detail: options.modelId,
        progressMode: "indeterminate",
        installLogLine: line
      })
  });
  await writeFile(markerPath, `${JSON.stringify({
    modelId: options.modelId,
    ignorePatterns,
    cachedAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
}

function resolveHuggingFaceRepoCacheDir(cacheDir: string, repoId: string): string {
  return join(cacheDir, "hub", `models--${repoId.replace(/[\\/]/g, "--")}`);
}

function emitPythonInstallLog(
  options: { onProgress?: (progress: FluxAssetProgress) => void },
  line: string
): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  const progress = parsePipDownloadProgressLine(trimmed);
  options.onProgress?.({
    progressText: "Flux Python 런타임 설치 중",
    detail: progress?.detail ?? trimmed.slice(0, 180),
    progressMode: progress ? "determinate" : "indeterminate",
    progressPercent: progress?.progressPercent,
    progressBytes: progress?.progressBytes,
    progressTotalBytes: progress?.progressTotalBytes,
    installLogLine: trimmed
  });
}

export function parsePipDownloadProgressLine(line: string): Pick<
  FluxAssetProgress,
  "detail" | "progressPercent" | "progressBytes" | "progressTotalBytes"
> | null {
  const text = line.trim();
  const fileStartMatch = text.match(/^(Downloading|Using cached)\s+(.+?)\s+\(([\d.]+)\s*([KMGT]?B)\)$/i);
  if (fileStartMatch) {
    const [, action, fileName, totalValue, totalUnit] = fileStartMatch;
    const totalBytes = parsePipByteValue(totalValue, totalUnit);
    if (totalBytes > 0) {
      const isCached = action.toLowerCase() === "using cached";
      return {
        detail: `${basename(fileName)} · ${isCached ? "캐시 사용" : `0 B / ${formatBytes(totalBytes)}`}`,
        progressPercent: isCached ? 1 : 0,
        progressBytes: isCached ? totalBytes : 0,
        progressTotalBytes: totalBytes
      };
    }
  }

  const progressMatch = text.match(/([\d.]+)\s*\/\s*([\d.]+)\s*([KMGT]?B)\b/i);
  if (!progressMatch) {
    return null;
  }
  const [, currentValue, totalValue, unit] = progressMatch;
  const progressBytes = parsePipByteValue(currentValue, unit);
  const progressTotalBytes = parsePipByteValue(totalValue, unit);
  if (progressBytes < 0 || progressTotalBytes <= 0) {
    return null;
  }
  return {
    detail: `${formatBytes(progressBytes)} / ${formatBytes(progressTotalBytes)}`,
    progressPercent: Math.max(0, Math.min(1, progressBytes / progressTotalBytes)),
    progressBytes,
    progressTotalBytes
  };
}

function parsePipByteValue(valueText: string, unitText: string): number {
  const value = Number(valueText);
  if (!Number.isFinite(value) || value < 0) {
    return -1;
  }
  const normalizedUnit = unitText.trim().toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
    TB: 1024 * 1024 * 1024 * 1024
  };
  return Math.round(value * (multipliers[normalizedUnit] ?? 1));
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    onLine?: (line: string) => void;
  } = {}
): Promise<void> {
  throwIfAborted(options.signal);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      env: {
        ...process.env,
        ...options.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderrTail = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const emitLines = (text: string, isError = false) => {
      const key = isError ? "stderr" : "stdout";
      let buffer = key === "stderr" ? stderrBuffer : stdoutBuffer;
      buffer += text;
      while (true) {
        const newline = findNextLineBreak(buffer);
        if (newline.index < 0) {
          break;
        }
        const line = buffer.slice(0, newline.index).trimEnd();
        buffer = buffer.slice(newline.index + newline.length);
        options.onLine?.(line);
      }
      if (key === "stderr") {
        stderrBuffer = buffer;
      } else {
        stdoutBuffer = buffer;
      }
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      reject(new DOMException("Aborted", "AbortError"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => emitLines(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrTail = `${stderrTail}${text}`.slice(-2400);
      emitLines(text, true);
    });
    child.on("error", (error) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("exit", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed (${code}). ${sanitizeFluxRuntimeStderr(stderrTail).trim()}`));
      }
    });
  });
}

function findNextLineBreak(text: string): { index: number; length: number } {
  const lf = text.indexOf("\n");
  const cr = text.indexOf("\r");
  if (lf < 0 && cr < 0) {
    return { index: -1, length: 0 };
  }
  if (cr >= 0 && (lf < 0 || cr < lf)) {
    return { index: cr, length: text[cr + 1] === "\n" ? 2 : 1 };
  }
  return { index: lf, length: 1 };
}

export function hfResolveUrl(repo: string, fileName: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(fileName)}`;
}

export async function ensureRemoteFile(options: {
  modelDir: string;
  url: string;
  fileName: string;
  label: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  const filePath = join(options.modelDir, options.fileName);
  if (await isUsableRemoteFile(filePath, options.url)) {
    options.onProgress?.({
      progressText: `${options.label} 캐시 사용`,
      detail: options.fileName,
      progressMode: "log-only",
      installLogLine: `캐시된 ${options.label} 파일을 사용합니다: ${options.fileName}`
    });
    return filePath;
  }
  await mkdir(options.modelDir, { recursive: true });
  await downloadToFile({
    url: options.url,
    outputPath: filePath,
    signal: options.signal,
    progressText: `${options.label} 다운로드 중`,
    label: options.fileName,
    onProgress: options.onProgress
  });
  return filePath;
}

async function downloadToFile(options: {
  url: string;
  outputPath: string;
  signal?: AbortSignal;
  progressText: string;
  label: string;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<void> {
  if (await isUsableRemoteFile(options.outputPath, options.url)) {
    options.onProgress?.({
      progressText: `${options.label} 캐시 사용`,
      detail: options.label,
      progressMode: "log-only",
      installLogLine: `캐시된 파일을 사용합니다: ${options.label}`
    });
    return;
  }
  await mkdir(dirname(options.outputPath), { recursive: true });
  const partPath = `${options.outputPath}.part`;
  await rm(partPath, { force: true });
  const totalBytes = await probeContentLength(options.url, options.signal);
  options.onProgress?.({
    progressText: options.progressText,
    detail: options.label,
    progressMode: totalBytes > 0 ? "determinate" : "log-only",
    progressPercent: totalBytes > 0 ? 0 : undefined,
    progressBytes: totalBytes > 0 ? 0 : undefined,
    progressTotalBytes: totalBytes > 0 ? totalBytes : undefined,
    installLogLine: `${options.label} 다운로드 시작`
  });

  const response = await fetch(options.url, {
    signal: options.signal,
    headers: { "User-Agent": "manga-gemma-translator" }
  });
  if (!response.ok || !response.body) {
    throw new Error(`${options.label} 다운로드에 실패했습니다 (${response.status}).`);
  }

  const responseTotalBytes = totalBytes || readContentLength(response);
  const reader = response.body.getReader();
  const writer = createWriteStream(partPath, { flags: "wx" });
  let receivedBytes = 0;
  let lastEmitAt = 0;
  try {
    while (true) {
      throwIfAborted(options.signal);
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = Buffer.from(value);
      await writeStreamChunk(writer, chunk);
      receivedBytes += chunk.byteLength;
      const now = Date.now();
      if (now - lastEmitAt > 500) {
        lastEmitAt = now;
        emitDownloadProgress(options, receivedBytes, responseTotalBytes);
      }
    }
    await finishWriteStream(writer);
    if (responseTotalBytes > 0 && receivedBytes !== responseTotalBytes) {
      throw new Error(`${options.label} 다운로드 크기가 맞지 않습니다 (${formatBytes(receivedBytes)} / ${formatBytes(responseTotalBytes)}).`);
    }
    await rm(options.outputPath, { force: true });
    await rename(partPath, options.outputPath);
    await writeRemoteFileMetadata(options.outputPath, {
      url: options.url,
      bytes: receivedBytes,
      downloadedAt: new Date().toISOString()
    });
    emitDownloadProgress(options, responseTotalBytes > 0 ? responseTotalBytes : receivedBytes, responseTotalBytes || receivedBytes, true);
  } catch (error) {
    writer.destroy();
    await rm(partPath, { force: true }).catch(() => {});
    throw error;
  }
}

function emitDownloadProgress(
  options: {
    progressText: string;
    label: string;
    onProgress?: (progress: FluxAssetProgress) => void;
  },
  receivedBytes: number,
  totalBytes: number,
  done = false
): void {
  options.onProgress?.({
    progressText: done ? `${options.label} 다운로드 완료` : options.progressText,
    detail: totalBytes > 0 ? `${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}` : `${formatBytes(receivedBytes)} 받음`,
    progressMode: totalBytes > 0 ? "determinate" : "log-only",
    progressPercent: totalBytes > 0 ? Math.min(1, receivedBytes / totalBytes) : undefined,
    progressBytes: totalBytes > 0 ? receivedBytes : undefined,
    progressTotalBytes: totalBytes > 0 ? totalBytes : undefined,
    installLogLine:
      totalBytes > 0
        ? `${options.label}: ${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`
        : `${options.label}: ${formatBytes(receivedBytes)}`
  });
}

function findFirstExecutable(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate && isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isUsableFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile() && statSync(filePath).size > 1024 * 1024;
  } catch {
    return false;
  }
}

async function isUsableRemoteFile(filePath: string, url: string): Promise<boolean> {
  if (!isUsableFile(filePath)) {
    return false;
  }
  const metadata = await readRemoteFileMetadata(filePath);
  if (!metadata) {
    return true;
  }
  try {
    const actualBytes = statSync(filePath).size;
    return metadata.url === url && metadata.bytes === actualBytes && actualBytes > 1024 * 1024;
  } catch {
    return false;
  }
}

async function readRemoteFileMetadata(filePath: string): Promise<RemoteFileMetadata | null> {
  try {
    return JSON.parse(await readFile(remoteFileMetadataPath(filePath), "utf8")) as RemoteFileMetadata;
  } catch {
    return null;
  }
}

async function writeRemoteFileMetadata(filePath: string, metadata: RemoteFileMetadata): Promise<void> {
  await writeFile(remoteFileMetadataPath(filePath), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function remoteFileMetadataPath(filePath: string): string {
  return `${filePath}.mgtmeta.json`;
}

function isExecutableFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function sha256FileSync(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

async function probeContentLength(url: string, signal?: AbortSignal): Promise<number> {
  try {
    const response = await fetch(url, { method: "HEAD", signal });
    return response.ok ? readContentLength(response) : 0;
  } catch {
    return 0;
  }
}

function readContentLength(response: Response): number {
  const value = Number(response.headers.get("content-length"));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function writeStreamChunk(writer: ReturnType<typeof createWriteStream>, chunk: Buffer): Promise<void> {
  if (writer.write(chunk)) {
    return;
  }
  await once(writer, "drain");
}

async function finishWriteStream(writer: ReturnType<typeof createWriteStream>): Promise<void> {
  writer.end();
  await once(writer, "finish");
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
