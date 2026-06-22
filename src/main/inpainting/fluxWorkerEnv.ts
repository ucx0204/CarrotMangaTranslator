import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type {
  FluxWorkerBackend,
  FluxWorkerLaunchSpec,
} from "./fluxWorkerTypes";

const DEFAULT_ROCM_PATH = process.platform === "win32" ? "" : "/opt/rocm";

export function buildRuntimePathEnv(
  command: string,
  backend: FluxWorkerBackend = "cuda-native",
): string {
  const dirs = createRuntimePathDirCollector();
  addBaseRuntimePathDirs(dirs.addDir, command);
  addBackendRuntimePathDirs(dirs.addDir, command, backend);
  addAncestorRuntimePathDirs(dirs.addDir, command);
  return dirs.values().join(delimiter);
}

export function buildFluxWorkerEnv(
  launch: FluxWorkerLaunchSpec,
): NodeJS.ProcessEnv {
  const launchPath = launch.env?.PATH;
  const env: NodeJS.ProcessEnv = {
    ...launch.env,
    PATH: [buildRuntimePathEnv(launch.executable, launch.backend), launchPath]
      .filter(Boolean)
      .join(delimiter),
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
  };
  applyPythonRuntimeEnv(env, launch.backend);
  copyHostRuntimeEnv(env);
  applyRocmRuntimeEnv(env, launch.backend);
  applyZludaRuntimeEnv(env, launch.backend);
  return env;
}

function createRuntimePathDirCollector(): {
  addDir: (dir: string | null | undefined) => void;
  values: () => string[];
} {
  const dirs: string[] = [];
  return {
    addDir(dir) {
      if (!dir || !existsSync(dir)) {
        return;
      }
      const normalized = dir.toLowerCase();
      if (!dirs.some((candidate) => candidate.toLowerCase() === normalized)) {
        dirs.push(dir);
      }
    },
    values: () => dirs,
  };
}

function addBaseRuntimePathDirs(
  addDir: (dir: string | null | undefined) => void,
  command: string,
): void {
  addDir(dirname(command));
}

function addBackendRuntimePathDirs(
  addDir: (dir: string | null | undefined) => void,
  command: string,
  backend: FluxWorkerBackend,
): void {
  if (backend === "cuda-native") {
    addCudaRuntimePathDirs(addDir, command);
    return;
  }
  if (backend === "python-rocm" || backend === "python-cpu") {
    addRocmRuntimePathDirs(addDir);
  }
}

function addCudaRuntimePathDirs(
  addDir: (dir: string | null | undefined) => void,
  command: string,
): void {
  const toolsDir = dirname(dirname(command));
  addDir(join(toolsDir, "mgt-flux-cuda12.9"));
  addDir(join(toolsDir, "cuda12.9"));
  addDir(
    process.env.CUDA_PATH_V12_9
      ? join(process.env.CUDA_PATH_V12_9, "bin")
      : null,
  );
  if (!isTruthy(process.env.MGT_FLUX_ALLOW_SYSTEM_CUDA)) {
    return;
  }
  for (const dir of [
    process.env.CUDA_PATH ? join(process.env.CUDA_PATH, "bin") : null,
    process.env.CUDA_HOME ? join(process.env.CUDA_HOME, "bin") : null,
    process.env.CUDA_PATH_V12_8
      ? join(process.env.CUDA_PATH_V12_8, "bin")
      : null,
    process.env.CUDA_PATH_V12_4
      ? join(process.env.CUDA_PATH_V12_4, "bin")
      : null,
    ...String(process.env.PATH ?? "").split(delimiter),
  ]) {
    addDir(dir);
  }
}

function addRocmRuntimePathDirs(
  addDir: (dir: string | null | undefined) => void,
): void {
  const rocmPath = process.env.ROCM_PATH || DEFAULT_ROCM_PATH;
  const hipPath = process.env.HIP_PATH || rocmPath;
  addDir(rocmPath ? join(rocmPath, "bin") : null);
  addDir(rocmPath ? join(rocmPath, "llvm", "bin") : null);
  addDir(hipPath ? join(hipPath, "bin") : null);
  for (const pathPart of String(process.env.PATH ?? "").split(delimiter)) {
    addDir(pathPart);
  }
}

function addAncestorRuntimePathDirs(
  addDir: (dir: string | null | undefined) => void,
  command: string,
): void {
  let current = dirname(command);
  for (let depth = 0; depth < 4; depth += 1) {
    addDir(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
}

function applyPythonRuntimeEnv(
  env: NodeJS.ProcessEnv,
  backend: FluxWorkerBackend,
): void {
  if (backend === "python-rocm" || backend === "python-cpu") {
    env.HF_HUB_DISABLE_SYMLINKS_WARNING =
      env.HF_HUB_DISABLE_SYMLINKS_WARNING || "1";
  }
}

function copyHostRuntimeEnv(env: NodeJS.ProcessEnv): void {
  for (const key of HOST_RUNTIME_ENV_KEYS) {
    const value = process.env[key];
    if (value && !env[key]) {
      env[key] = value;
    }
  }
}

const HOST_RUNTIME_ENV_KEYS = [
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "HOME",
  "ROCM_PATH",
  "HIP_PATH",
  "HIP_VISIBLE_DEVICES",
  "ROCR_VISIBLE_DEVICES",
  "GPU_DEVICE_ORDINAL",
  "HSA_OVERRIDE_GFX_VERSION",
  "HSA_ENABLE_SDMA",
  "PYTORCH_HIP_ALLOC_CONF",
  "LD_LIBRARY_PATH",
  "LIBRARY_PATH",
  "HF_HOME",
  "HUGGINGFACE_HUB_CACHE",
] as const;

function applyRocmRuntimeEnv(
  env: NodeJS.ProcessEnv,
  backend: FluxWorkerBackend,
): void {
  appendHostPathForPythonBackend(env, backend);
  if (backend === "python-rocm") {
    applyRocmBackendVariables(env);
  }
}

function appendHostPathForPythonBackend(
  env: NodeJS.ProcessEnv,
  backend: FluxWorkerBackend,
): void {
  if (process.env.PATH && isPythonBackend(backend)) {
    env.PATH = `${env.PATH}${delimiter}${process.env.PATH}`;
  }
}

function applyRocmBackendVariables(env: NodeJS.ProcessEnv): void {
  const rocmPath = process.env.ROCM_PATH || DEFAULT_ROCM_PATH;
  const hipPath = process.env.HIP_PATH || rocmPath;
  if (rocmPath && !env.ROCM_PATH) {
    env.ROCM_PATH = rocmPath;
  }
  if (hipPath && !env.HIP_PATH) {
    env.HIP_PATH = hipPath;
  }
  if (process.platform !== "win32" && rocmPath) {
    env.LD_LIBRARY_PATH = [
      env.LD_LIBRARY_PATH,
      join(rocmPath, "lib"),
      join(rocmPath, "lib64"),
    ]
      .filter(Boolean)
      .join(":");
  }
}

function isPythonBackend(backend: FluxWorkerBackend): boolean {
  return backend === "python-rocm" || backend === "python-cpu";
}

function applyZludaRuntimeEnv(
  env: NodeJS.ProcessEnv,
  backend: FluxWorkerBackend,
): void {
  if (backend !== "zluda-native") {
    return;
  }
  env.RUST_BACKTRACE ||= "1";
  env.RUST_LOG ||= "warn,koharu_runtime=info";
}

function isTruthy(value: unknown): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}
