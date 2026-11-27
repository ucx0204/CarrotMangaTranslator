import { execFile } from "node:child_process";
import { chmod, copyFile } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";
import { promisify } from "node:util";
import { normalizeComputeGpuIndex } from "../../shared/gpuSettings";
import { ensureNativeInferenceRuntime } from "./nativeInferenceRuntime";
import type { NativeInferenceBackend } from "./nativeInferencePlan";
import type { RuntimeAssetProgress } from "./modelDownloads";
import { ensureManagedKoharuRunner } from "./koharuRunner";

const execute = promisify(execFile);

type LaunchOptions = {
  runtimeDir: string;
  executable?: string;
  engine: "torch" | "diffusion" | "qwen-image";
  backend: NativeInferenceBackend;
  computeGpuIndex?: number;
  signal?: AbortSignal;
  onProgress?: (progress: RuntimeAssetProgress) => void;
};

export async function prepareNativeInferenceLaunch(
  options: LaunchOptions,
): Promise<{ executable: string; manifest: string; env: NodeJS.ProcessEnv }> {
  const rocmTarget =
    options.backend === "rocm" ? await probeRocmTarget(options) : undefined;
  const runtime = await ensureNativeInferenceRuntime({
    ...options,
    rocmTarget,
  });
  let executable = options.executable ?? runtime.executable;
  if (!executable) throw new Error("Native runtime has no executable");
  if (process.platform === "darwin") {
    // Koharu's macOS bindings resolve dylibs relative to the worker executable.
    const sourceExecutable = executable;
    executable = join(runtime.directory, basename(sourceExecutable));
    if (sourceExecutable !== executable)
      await copyFile(sourceExecutable, executable);
    await chmod(executable, 0o755);
  }
  return {
    executable,
    manifest: runtime.manifest,
    env: {
      PATH: [
        ...runtime.pathDirectories.map(runtimeEnvironmentPath),
        process.env.PATH,
      ]
        .filter(Boolean)
        .join(delimiter),
      ...(options.backend === "rocm"
        ? {
            HIP_PATH: runtimeEnvironmentPath(
              join(runtime.directory, "_rocm_sdk_core"),
            ),
            ROCM_PATH: runtimeEnvironmentPath(
              join(runtime.directory, "_rocm_sdk_core"),
            ),
          }
        : {}),
    },
  };
}

function runtimeEnvironmentPath(path: string): string {
  // Windows SDKs may append forward slashes to these directories. Keep the
  // installer's verbatim namespace out of native-library environment paths.
  return process.platform === "win32"
    ? path
        .replace(/^\\\\\?\\UNC\\/i, "\\\\")
        .replace(/^\\\\\?\\([a-z]:\\)/i, "$1")
    : path;
}

async function probeRocmTarget(options: LaunchOptions): Promise<string> {
  const probe =
    options.engine === "qwen-image"
      ? (await ensureManagedKoharuRunner(options)).path
      : options.executable;
  if (!probe) throw new Error("ROCm probe requires an executable");
  const core = await ensureNativeInferenceRuntime({
    ...options,
    engine: "rocm-probe",
    qwenRocmProbe: options.engine === "qwen-image",
  });
  const index = normalizeComputeGpuIndex(options.computeGpuIndex) ?? 0;
  const probeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [
      ...core.pathDirectories.map(runtimeEnvironmentPath),
      process.env.PATH,
    ]
      .filter(Boolean)
      .join(delimiter),
  };
  // The probe selects a physical index; the worker applies visibility afterward.
  for (const key of [
    "CUDA_VISIBLE_DEVICES",
    "HIP_VISIBLE_DEVICES",
    "ROCR_VISIBLE_DEVICES",
    "GPU_DEVICE_ORDINAL",
  ]) {
    delete probeEnv[key];
  }
  const { stdout } = await execute(
    probe,
    ["--probe-rocm", core.manifest, String(index)],
    {
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 256 * 1024,
      signal: options.signal,
      env: probeEnv,
    },
  );
  const result = JSON.parse(stdout) as {
    schema?: unknown;
    gpu_index?: unknown;
    target?: unknown;
  };
  if (
    result.schema !== 1 ||
    result.gpu_index !== index ||
    typeof result.target !== "string" ||
    !/^gfx[0-9a-f]+$/.test(result.target)
  ) {
    throw new Error("ROCm GPU 대상 확인에 실패했습니다.");
  }
  return result.target;
}
