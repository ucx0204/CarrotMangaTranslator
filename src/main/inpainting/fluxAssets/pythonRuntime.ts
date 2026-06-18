import { mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  FLUX_DIFFUSERS_MODEL_ID,
  FLUX_MODEL_FILE,
  FLUX_MODEL_REPO,
  FLUX_SDCPP_LLM_FILE,
  FLUX_SDCPP_LLM_REPO,
  FLUX_SDCPP_VAE_FILE,
  FLUX_VAE_REPO,
} from "./constants";
import type {
  FluxAssetProgress,
  FluxPythonBackend,
  PythonCommand,
} from "./types";
import { runCommand } from "./errors";
import { ensureRemoteFile, hfResolveUrl } from "./downloads";
import { emitPythonInstallLog } from "./progress";
import {
  shouldAllowFluxRocmSourceBuildFallback,
  resolveFluxPythonMode,
  resolvePythonBuildPackages,
  resolvePythonFluxPackages,
  resolvePythonRuntimeInstallBatches,
} from "./manifests";
import { initializeWindowsRocmSdk, buildTargetPythonEnv } from "./rocmRuntime";
import { ensurePrebuiltFluxRocmPythonRuntime } from "./rocmPrebuiltRuntime";
import {
  findPythonCommand,
  ensureEmbeddedPythonPackagePath,
} from "./pythonBootstrap";
import {
  ensureFluxPythonModelCache,
  verifyFluxPythonRuntime,
} from "./pythonRuntimePackages";
import {
  ensureFluxPythonWorker,
  findFluxPythonWorkerSource,
  resolveCurrentFluxPythonRuntime,
  resolveFluxPythonRuntimeLayout,
  resolveFluxPythonWorkerFile,
} from "./pythonRuntimeLayout";
import { sha256FileSync } from "./fileProbe";
import type { FluxWorkerLaunchSpec } from "../fluxWorker";

export async function ensureFluxPythonRuntime(options: {
  runtimeDir: string;
  modelDir: string;
  backend: FluxPythonBackend;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<FluxWorkerLaunchSpec> {
  await mkdir(options.runtimeDir, { recursive: true });
  const layout = resolveFluxPythonRuntimeLayout(
    options.runtimeDir,
    options.backend,
  );
  const { runtimeDir, venvPythonPath, packageDir, workerPath, markerPath } =
    layout;
  const runtimeInstallBatches = resolvePythonRuntimeInstallBatches(
    options.backend,
  );
  const buildPackages = resolvePythonBuildPackages(options.backend);
  const extraPackages = resolvePythonFluxPackages(options.backend);
  const workerFile = resolveFluxPythonWorkerFile(options.backend);
  const workerSource = findFluxPythonWorkerSource(workerFile);
  const workerHash = workerSource ? sha256FileSync(workerSource) : "missing";
  const expectedMarker = {
    backend: options.backend,
    runtimeInstallBatches: runtimeInstallBatches.map((batch) => ({
      id: batch.id,
      pipArgs: batch.pipArgs,
    })),
    buildPackages,
    packages: extraPackages,
    worker: workerFile,
    workerHash,
  };

  let pythonRuntime = await resolveCurrentFluxPythonRuntime({
    runtimeDir,
    venvPythonPath,
    packageDir,
    markerPath,
    expectedMarker,
  });

  if (!pythonRuntime) {
    if (options.backend === "python-rocm" && process.platform === "win32") {
      pythonRuntime = await ensurePrebuiltFluxRocmPythonRuntime({
        layout,
        expectedMarker,
        signal: options.signal,
        onProgress: options.onProgress,
      });
    }

    if (!pythonRuntime) {
      if (
        options.backend === "python-rocm" &&
        process.platform === "win32" &&
        !shouldAllowFluxRocmSourceBuildFallback()
      ) {
        throw new Error(
          "Flux ROCm prebuilt 런타임을 준비하지 못했습니다. 사용자 PC에서 C++/ROCm 소스 빌드는 비활성화되어 있습니다. " +
            "GitHub Release의 mgt-flux-rocm 런타임 ZIP을 확인하거나 MGT_FLUX_ROCM_ALLOW_SOURCE_BUILD=1로 개발용 소스 빌드를 명시적으로 허용하세요.",
        );
      }

      await rm(runtimeDir, { recursive: true, force: true });
      await mkdir(runtimeDir, { recursive: true });
      await ensureFluxPythonWorker(runtimeDir, workerFile);
      options.onProgress?.({
        progressText:
          options.backend === "python-rocm"
            ? "Flux ROCm 런타임 설치 중"
            : "Flux CPU 런타임 설치 중",
        detail: "Python target package install",
        progressMode: "log-only",
        installLogLine: "Flux 전용 패키지 폴더에 Python 패키지를 설치합니다.",
      });
      const basePython = await findPythonCommand({
        runtimeDir,
        signal: options.signal,
        onProgress: options.onProgress,
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
        options.backend === "python-rocm" && process.platform === "win32"
          ? "python-cpu"
          : options.backend,
        { requireNativeBuildEnv: false },
      );
      await runCommand(
        installPython.command,
        [
          ...installPython.args,
          "-m",
          "pip",
          "install",
          "--upgrade",
          "pip",
          "setuptools",
          "wheel",
        ],
        {
          signal: options.signal,
          env: installEnv,
          onLine: (line) => emitPythonInstallLog(options, line),
        },
      );
      if (buildPackages.length > 0) {
        options.onProgress?.({
          progressText: "Flux 빌드 도구 설치 중",
          detail: buildPackages.join(" "),
          progressMode: "indeterminate",
          installLogLine:
            "stable-diffusion.cpp Python 바인딩 빌드 도구를 먼저 설치합니다.",
        });
        await runCommand(
          installPython.command,
          [
            ...installPython.args,
            "-m",
            "pip",
            "install",
            "--upgrade",
            ...buildPackages,
          ],
          {
            signal: options.signal,
            env: installEnv,
            onLine: (line) => emitPythonInstallLog(options, line),
          },
        );
      }
      for (const batch of runtimeInstallBatches) {
        options.onProgress?.({
          progressText: batch.progressText,
          detail: batch.detail,
          progressMode: "indeterminate",
          installLogLine: batch.installLogLine,
        });
        await runCommand(
          installPython.command,
          [
            ...installPython.args,
            "-m",
            "pip",
            "install",
            "--target",
            packageDir,
            ...batch.pipArgs,
          ],
          {
            signal: options.signal,
            env: installEnv,
            onLine: (line) => emitPythonInstallLog(options, line),
          },
        );
      }
      if (options.backend === "python-rocm" && process.platform === "win32") {
        await initializeWindowsRocmSdk({
          python: installPython,
          packageDir,
          runtimeDir,
          signal: options.signal,
          onProgress: options.onProgress,
        });
        installEnv = buildTargetPythonEnv(
          runtimeDir,
          packageDir,
          options.backend,
          { requireNativeBuildEnv: true },
        );
      }
      options.onProgress?.({
        progressText: "Flux Python 패키지 설치 중",
        detail: extraPackages.join(" "),
        progressMode: "indeterminate",
        installLogLine:
          options.backend === "python-rocm"
            ? "stable-diffusion.cpp Python 바인딩을 ROCm/HIP용으로 빌드합니다."
            : "diffusers/transformers/accelerate 패키지를 설치합니다.",
      });
      await runCommand(
        installPython.command,
        [
          ...installPython.args,
          "-m",
          "pip",
          "install",
          "--target",
          packageDir,
          ...extraPackages,
        ],
        {
          signal: options.signal,
          env: installEnv,
          onLine: (line) => emitPythonInstallLog(options, line),
        },
      );
      pythonRuntime = {
        mode: "target",
        command: installPython.command,
        executable: installPython.command,
        args: installPython.args,
        env: installEnv,
        packageDir,
      };
      await verifyFluxPythonRuntime(
        pythonRuntime,
        options.backend,
        options.signal,
      );
      await writeFile(
        markerPath,
        `${JSON.stringify(
          {
            ...expectedMarker,
            runtimeMode,
            pythonPath: pythonRuntime.executable,
            packageDir: pythonRuntime.packageDir,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
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
      onProgress: options.onProgress,
    });
    const vaePath = await ensureRemoteFile({
      modelDir: options.modelDir,
      fileName: FLUX_SDCPP_VAE_FILE,
      label: "Flux small decoder",
      url: hfResolveUrl(FLUX_VAE_REPO, FLUX_SDCPP_VAE_FILE),
      signal: options.signal,
      onProgress: options.onProgress,
    });
    const llmPath = await ensureRemoteFile({
      modelDir: options.modelDir,
      fileName: FLUX_SDCPP_LLM_FILE,
      label: "Flux text encoder GGUF",
      url: hfResolveUrl(FLUX_SDCPP_LLM_REPO, FLUX_SDCPP_LLM_FILE),
      signal: options.signal,
      onProgress: options.onProgress,
    });
    options.onProgress?.({
      progressText: "Flux stable-diffusion.cpp 런타임 준비 완료",
      detail: "ROCm · GGUF Q4_K_M",
      progressMode: "log-only",
      installLogLine:
        "Flux stable-diffusion.cpp ROCm/HIP + GGUF 런타임을 사용합니다.",
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
        llmPath,
      ],
      env: {
        ...pythonRuntime.env,
        HF_HOME: options.modelDir,
        HUGGINGFACE_HUB_CACHE: join(options.modelDir, "hub"),
        HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
      },
    };
  }

  const modelId =
    process.env.MANGA_TRANSLATOR_FLUX_PYTHON_MODEL_ID ??
    process.env.MGT_FLUX_PYTHON_MODEL_ID ??
    FLUX_DIFFUSERS_MODEL_ID;
  const mode = resolveFluxPythonMode();
  await ensureFluxPythonModelCache({
    pythonRuntime,
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
      options.modelDir,
    ],
    env: {
      ...pythonRuntime.env,
      HF_HOME: options.modelDir,
      HUGGINGFACE_HUB_CACHE: join(options.modelDir, "hub"),
      HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
    },
  };
}
