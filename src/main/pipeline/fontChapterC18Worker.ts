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
type EnvironmentBuilder = {
  buildOcrRuntimeEnv: (
    options: TranslationOptions,
    runtime: Awaited<
      ReturnType<ReturnType<typeof loadSimplePageRuntime>["ensureOcrRuntime"]>
    >,
  ) => NodeJS.ProcessEnv;
};

export async function launchFontChapterC18Worker(
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
  return new JsonLinesWorkerClient<{ request: string }, WorkerResponse>({
    executable: runtime.pythonPath,
    args: ["-u", join(paths.runtimeDir, "font-chapter-c18/worker.py")],
    env: {
      ...env,
      C18_HAYAI_PYTHONPATH: env.PYTHONPATH ?? "",
      PYTHONPATH: [
        join(paths.dataRoot, "font-chapter-c18/v1/python-packages"),
        env.PYTHONPATH,
      ]
        .filter(Boolean)
        .join(delimiter),
      PYTHONUTF8: "1",
      PYTHONDONTWRITEBYTECODE: "1",
    },
    workerName: "C18 chapter font matching",
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
