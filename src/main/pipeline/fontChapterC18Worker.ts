import { delimiter, join } from "node:path";
import type { AppPaths } from "../appPaths";
import type { TranslationOptions } from "../appSettings";
import { loadSimplePageRuntime } from "../simplePageRuntime";
import { loadRuntimeModuleFromDirectory } from "../runtimeModuleLoader";
import {
  JsonLinesWorkerClient,
  type JsonLinesWorkerResponse,
} from "../runtimeSupport/jsonLinesWorkerClient";
import { logPipelineInfo, logPipelineWarning } from "./pipelineLogger";

type WorkerResponse = JsonLinesWorkerResponse & { result?: unknown };
type BatchPolicy = {
  resolveOcrCpuWorkerCount: (
    options: TranslationOptions & { ocrCpuMinPagesPerWorker: number },
    count: number,
  ) => number;
};
type EnvironmentBuilder = {
  buildOcrRuntimeEnv: (
    options: TranslationOptions,
    runtime: Awaited<
      ReturnType<ReturnType<typeof loadSimplePageRuntime>["ensureOcrRuntime"]>
    >,
  ) => NodeJS.ProcessEnv;
};

export async function prepareFontChapterC18WorkerRuntime(
  paths: AppPaths,
  options: TranslationOptions,
) {
  const runtime = await loadSimplePageRuntime(
    paths.runtimeDir,
  ).ensureOcrRuntime(options);
  if (!runtime.pythonPath)
    throw new Error("C18 requires the installed Hayai Python runtime.");
  const environment = loadRuntimeModuleFromDirectory(
    paths.runtimeDir,
    "ocrEnvironment",
  ) as EnvironmentBuilder;
  const env = environment.buildOcrRuntimeEnv(options, runtime);
  const shell = loadRuntimeModuleFromDirectory(
    paths.runtimeDir,
    "shellCommand",
  ) as {
    runCommand: (
      command: { executable: string; args: string[] },
      options: {
        env: NodeJS.ProcessEnv;
        signal?: AbortSignal;
        timeoutMs: number;
      },
    ) => Promise<{ stdout: string }>;
  };
  const probe = await shell.runCommand(
    {
      executable: runtime.pythonPath,
      args: [
        "-c",
        "import sys; print(sys.implementation.cache_tag); print(sys.version.split()[0])",
      ],
    },
    { env, signal: options.abortSignal, timeoutMs: 30_000 },
  );
  const [pythonAbi, pythonVersion] = probe.stdout.trim().split(/\r?\n/);
  if (pythonAbi !== "cpython-312" && pythonAbi !== "cpython-314")
    throw new Error(`Unsupported font matching Python ABI: ${pythonAbi}`);
  logPipelineInfo("C23 Python runtime selected", {
    pythonPath: runtime.pythonPath,
    pythonAbi,
    pythonVersion,
  });
  return { pythonPath: runtime.pythonPath, env, pythonAbi };
}

export async function launchFontChapterC18Worker(
  paths: AppPaths,
  options: TranslationOptions,
  assets: string,
  requestTimeoutMs: number,
  prepared?: Awaited<ReturnType<typeof prepareFontChapterC18WorkerRuntime>>,
) {
  options.abortSignal?.throwIfAborted();
  const runtime =
    prepared ?? (await prepareFontChapterC18WorkerRuntime(paths, options));
  const { env } = runtime;
  const batchPolicy = loadRuntimeModuleFromDirectory(
    paths.runtimeDir,
    "ocrBatch",
  ) as BatchPolicy;
  const workers =
    options.ocrDevice === "cpu"
      ? batchPolicy.resolveOcrCpuWorkerCount(
          { ...options, ocrCpuMinPagesPerWorker: 1 },
          8,
        )
      : 1;
  return new JsonLinesWorkerClient<{ request: string }, WorkerResponse>({
    executable: runtime.pythonPath,
    args: ["-u", join(paths.runtimeDir, "font-chapter-c18/worker.py")],
    env: {
      ...env,
      C18_HAYAI_PYTHONPATH: env.PYTHONPATH ?? "",
      C18_HAYAI_CPU_WORKERS: String(workers),
      PYTHONPATH: [join(assets, "python-packages"), env.PYTHONPATH]
        .filter(Boolean)
        .join(delimiter),
      PYTHONUTF8: "1",
      PYTHONDONTWRITEBYTECODE: "1",
    },
    workerName: "C18 chapter font matching",
    requestTimeoutMs,
    buildExitError: (code, stderr) =>
      new Error(`C18 worker exited (${code}): ${stderr}`),
    buildNotRunningError: (stderr) =>
      new Error(`C18 worker unavailable: ${stderr}`),
    sanitizeStderr: (text) => text,
    onStderr: (text) =>
      logPipelineInfo("C18 source analysis", { detail: text.slice(-1600) }),
    onTerminationError: (error) =>
      logPipelineWarning("C18 worker cleanup failed", { error }),
  });
}
