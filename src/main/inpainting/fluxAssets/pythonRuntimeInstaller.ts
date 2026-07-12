import { mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { tMain } from "../localization";
import type {
  FluxAssetProgress,
  FluxPythonBackend,
  FluxPythonInstallBatch,
  FluxPythonRuntime,
  FluxPythonRuntimeLayout,
  PythonCommand,
} from "./types";
import { runCommand } from "./errors";
import { emitPythonInstallLog } from "./progress";
import { shouldAllowFluxRocmSourceBuildFallback } from "./manifests";
import { ensurePrebuiltFluxRocmPythonRuntime } from "./rocmPrebuiltRuntime";
import {
  findPythonCommand,
  ensureEmbeddedPythonPackagePath,
} from "./pythonBootstrap";
import { initializeWindowsRocmSdk, buildTargetPythonEnv } from "./rocmRuntime";
import { verifyFluxPythonRuntime } from "./pythonRuntimePackages";
import { ensureFluxPythonWorker } from "./pythonRuntimeLayout";

export type FluxPythonExpectedMarker = {
  backend: FluxPythonBackend;
  buildPackages: string[];
  packages: string[];
  runtimeInstallBatches: Array<{ id: string; pipArgs: string[] }>;
  worker: string;
  workerHash: string;
};

type EnsureTargetFluxPythonRuntimeOptions = {
  backend: FluxPythonBackend;
  buildPackages: string[];
  expectedMarker: FluxPythonExpectedMarker;
  extraPackages: string[];
  layout: FluxPythonRuntimeLayout;
  onProgress?: (progress: FluxAssetProgress) => void;
  runtimeInstallBatches: FluxPythonInstallBatch[];
  signal?: AbortSignal;
  workerFile: string;
};

export async function ensureMissingFluxPythonRuntime(
  options: EnsureTargetFluxPythonRuntimeOptions,
): Promise<FluxPythonRuntime> {
  const prebuiltRuntime = await tryEnsurePrebuiltRocmRuntime(options);
  if (prebuiltRuntime) {
    return prebuiltRuntime;
  }
  assertRocmSourceBuildAllowed(options.backend);
  return installTargetFluxPythonRuntime(options);
}

async function tryEnsurePrebuiltRocmRuntime(
  options: EnsureTargetFluxPythonRuntimeOptions,
): Promise<FluxPythonRuntime | null> {
  if (options.backend !== "python-rocm" || process.platform !== "win32") {
    return null;
  }
  return ensurePrebuiltFluxRocmPythonRuntime({
    layout: options.layout,
    expectedMarker: options.expectedMarker,
    signal: options.signal,
    onProgress: options.onProgress,
  });
}

function assertRocmSourceBuildAllowed(backend: FluxPythonBackend): void {
  if (
    backend === "python-rocm" &&
    process.platform === "win32" &&
    !shouldAllowFluxRocmSourceBuildFallback()
  ) {
    throw new Error(
      "Flux ROCm prebuilt 런타임을 준비하지 못했습니다. 사용자 PC에서 C++/ROCm 소스 빌드는 비활성화되어 있습니다. " +
        "GitHub Release의 mgt-flux-rocm 런타임 ZIP을 확인하거나 MGT_FLUX_ROCM_ALLOW_SOURCE_BUILD=1로 개발용 소스 빌드를 명시적으로 허용하세요.",
    );
  }
}

async function installTargetFluxPythonRuntime(
  options: EnsureTargetFluxPythonRuntimeOptions,
): Promise<FluxPythonRuntime> {
  const { packageDir, runtimeDir } = options.layout;
  await resetTargetRuntimeDir(options);
  const installPython = await prepareTargetPython(options);
  let installEnv = buildInstallEnv(options, false);
  await installPipBootstrap(options, installPython, installEnv);
  await installBuildPackages(options, installPython, installEnv);
  await installRuntimeBatches(options, installPython, installEnv);
  installEnv = await maybeInitializeWindowsRocmSdk(
    options,
    installPython,
    installEnv,
  );
  await installFluxPackages(options, installPython, installEnv);
  const pythonRuntime = {
    mode: "target" as const,
    command: installPython.command,
    executable: installPython.command,
    args: installPython.args,
    env: installEnv,
    packageDir,
  };
  await verifyFluxPythonRuntime(pythonRuntime, options.backend, options.signal);
  await writeTargetRuntimeMarker(options, pythonRuntime);
  void runtimeDir;
  return pythonRuntime;
}

async function resetTargetRuntimeDir(
  options: EnsureTargetFluxPythonRuntimeOptions,
): Promise<void> {
  await rm(options.layout.runtimeDir, { recursive: true, force: true });
  await mkdir(options.layout.runtimeDir, { recursive: true });
  await ensureFluxPythonWorker(options.layout.runtimeDir, options.workerFile);
  options.onProgress?.({
    progressText:
      options.backend === "python-rocm"
        ? tMain("inpainting.runtime.fluxRocmInstalling")
        : tMain("inpainting.runtime.fluxCpuInstalling"),
    detail: tMain("inpainting.runtime.pythonTargetInstalling"),
    progressMode: "log-only",
    installLogLine: "Flux 전용 패키지 폴더에 Python 패키지를 설치합니다.",
  });
}

async function prepareTargetPython(
  options: EnsureTargetFluxPythonRuntimeOptions,
): Promise<PythonCommand> {
  const basePython = await findPythonCommand({
    runtimeDir: options.layout.runtimeDir,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  await mkdir(options.layout.packageDir, { recursive: true });
  if (isAbsolute(basePython.command) && basePython.args.length === 0) {
    ensureEmbeddedPythonPackagePath(
      basePython.command,
      options.layout.packageDir,
    );
  }
  return basePython;
}

function buildInstallEnv(
  options: EnsureTargetFluxPythonRuntimeOptions,
  requireNativeBuildEnv: boolean,
): NodeJS.ProcessEnv {
  return buildTargetPythonEnv(
    options.layout.runtimeDir,
    options.layout.packageDir,
    options.backend === "python-rocm" &&
      process.platform === "win32" &&
      !requireNativeBuildEnv
      ? "python-cpu"
      : options.backend,
    { requireNativeBuildEnv },
  );
}

async function installPipBootstrap(
  options: EnsureTargetFluxPythonRuntimeOptions,
  python: PythonCommand,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await runPipInstall(options, python, env, [
    "--upgrade",
    "pip",
    "setuptools",
    "wheel",
  ]);
}

async function installBuildPackages(
  options: EnsureTargetFluxPythonRuntimeOptions,
  python: PythonCommand,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (options.buildPackages.length === 0) {
    return;
  }
  options.onProgress?.({
    progressText: "Flux 빌드 도구 설치 중",
    detail: options.buildPackages.join(" "),
    progressMode: "indeterminate",
    installLogLine:
      "stable-diffusion.cpp Python 바인딩 빌드 도구를 먼저 설치합니다.",
  });
  await runPipInstall(options, python, env, [
    "--upgrade",
    ...options.buildPackages,
  ]);
}

async function installRuntimeBatches(
  options: EnsureTargetFluxPythonRuntimeOptions,
  python: PythonCommand,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  for (const batch of options.runtimeInstallBatches) {
    options.onProgress?.({
      progressText: batch.progressText,
      detail: batch.detail,
      progressMode: "indeterminate",
      installLogLine: batch.installLogLine,
    });
    await runPipInstall(options, python, env, [
      "--target",
      options.layout.packageDir,
      ...batch.pipArgs,
    ]);
  }
}

async function maybeInitializeWindowsRocmSdk(
  options: EnsureTargetFluxPythonRuntimeOptions,
  python: PythonCommand,
  env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  if (options.backend !== "python-rocm" || process.platform !== "win32") {
    return env;
  }
  await initializeWindowsRocmSdk({
    python,
    packageDir: options.layout.packageDir,
    runtimeDir: options.layout.runtimeDir,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  return buildInstallEnv(options, true);
}

async function installFluxPackages(
  options: EnsureTargetFluxPythonRuntimeOptions,
  python: PythonCommand,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  options.onProgress?.({
    progressText: "Flux Python 패키지 설치 중",
    detail: options.extraPackages.join(" "),
    progressMode: "indeterminate",
    installLogLine:
      options.backend === "python-rocm"
        ? "stable-diffusion.cpp Python 바인딩을 ROCm/HIP용으로 빌드합니다."
        : "diffusers/transformers/accelerate 패키지를 설치합니다.",
  });
  await runPipInstall(options, python, env, [
    "--target",
    options.layout.packageDir,
    ...options.extraPackages,
  ]);
}

async function runPipInstall(
  options: EnsureTargetFluxPythonRuntimeOptions,
  python: PythonCommand,
  env: NodeJS.ProcessEnv,
  pipArgs: string[],
): Promise<void> {
  await runCommand(
    python.command,
    [...python.args, "-m", "pip", "install", ...pipArgs],
    {
      signal: options.signal,
      env,
      onLine: (line) => emitPythonInstallLog(options, line),
    },
  );
}

async function writeTargetRuntimeMarker(
  options: EnsureTargetFluxPythonRuntimeOptions,
  pythonRuntime: FluxPythonRuntime,
): Promise<void> {
  await writeFile(
    options.layout.markerPath,
    `${JSON.stringify(
      {
        ...options.expectedMarker,
        runtimeMode: "target",
        pythonPath: pythonRuntime.executable,
        packageDir: pythonRuntime.packageDir,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
