// @ts-check
/** @typedef {import("../runtime-jsdoc-types").DetailedError} DetailedError */
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { label?: string | null; onProgress?: ((progress: Record<string, unknown>) => void) | null; port?: unknown; reuseServer?: boolean | null; serverPath?: string | null; serverLogPath?: string | null }} ServerRuntimeOptions */
/** @typedef {{ baseUrl: string; child: import("node:child_process").ChildProcess | null; startedByScript: boolean; serverLogPath?: string | null }} StartedServer */
/** @typedef {{ child: import("node:child_process").ChildProcess; recent: { stdout: string; stderr: string }; logStream: import("node:fs").WriteStream | null; onAbort: () => void }} RunningServer */
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const { bundledServerCandidates } = require("../resolve-llama-runtime.cjs");
const { runtimeOverrideEnv } = require("../simple-page-child-env.cjs");
const { resolveWorkingDir } = require("../simple-page-cache-paths.cjs");
const {
  resolveConfiguredModelFile,
} = require("../simple-page-model-config.cjs");
const {
  defaultServerPath,
  resolveToolsDir,
} = require("../simple-page-runtime-paths.cjs");
const {
  createAbortError,
  shrinkBuffer,
  terminateChildProcessTree,
} = require("../simple-page-shell-utils.cjs");
const {
  ensureDefaultLlamaRuntimeDownloaded,
  ensureHfModelAssetsDownloaded,
  inspectModelLaunch,
} = require("../simple-page-model-assets.cjs");
const { buildOptionSummary } = require("../simple-page-request-summary.cjs");
const {
  buildLaunchArgs,
  isServerRuntimeCompatibleWithModel,
} = require("../simple-page-launch-args.cjs");
const {
  createDetailedError,
  emitRuntimeProgress,
  truncateText,
} = require("../simple-page-runtime-common.cjs");
const { buildLlamaServerEnv } = require("../model/server-environment.cjs");
const {
  isIncompleteManagedLlamaRuntime,
  verifyLlamaRuntimePreflight,
} = require("../model/server-preflight.cjs");
const {
  createServerLogStream,
  emitServerInstallLog,
} = require("./llama-server-logging.cjs");
const {
  isReachable,
  waitForReadyOrExit,
} = require("./llama-server-readiness.cjs");

/** @param {ServerRuntimeOptions} options @returns {Promise<StartedServer>} */
async function startServer(options) {
  const baseUrl = `http://127.0.0.1:${options.port}/v1`;
  if (await canReuseServer(baseUrl, options))
    return { baseUrl, child: null, startedByScript: false };
  const serverPath = await resolveServerPath(baseUrl, options);
  await verifyLlamaRuntimePreflight(serverPath, options);
  await ensureHfModelAssetsDownloaded(options, inspectModelLaunch(options));
  const launchArgs = buildLaunchArgs({ ...options, serverPath });
  emitServerStarting(options);
  const running = spawnServer(serverPath, launchArgs, options);
  try {
    await awaitServerReady(baseUrl, serverPath, launchArgs, options, running);
    emitServerReady(options);
  } catch (error) {
    terminateChildProcessTree(running.child);
    throw normalizeStartupError(
      error,
      baseUrl,
      serverPath,
      launchArgs,
      options,
      running.recent,
    );
  } finally {
    options.abortSignal?.removeEventListener?.("abort", running.onAbort);
  }
  return {
    baseUrl,
    child: running.child,
    startedByScript: true,
    serverLogPath: options.serverLogPath,
  };
}

/** @param {string} baseUrl @param {ServerRuntimeOptions} options */
async function canReuseServer(baseUrl, options) {
  return Boolean(
    options.reuseServer &&
    shouldAllowExistingLlamaServerReuse(options) &&
    (await isReachable(baseUrl)),
  );
}

/** @param {RuntimeOptions} [options] */
function shouldAllowExistingLlamaServerReuse(options = {}) {
  return isTruthy(
    runtimeOverrideEnv("MGT_ALLOW_LLAMA_SERVER_REUSE", options) ??
      runtimeOverrideEnv("MANGA_TRANSLATOR_ALLOW_LLAMA_SERVER_REUSE", options),
  );
}

/** @param {string} baseUrl @param {ServerRuntimeOptions} options */
async function resolveServerPath(baseUrl, options) {
  const requested = requestedServerPath(options);
  if (
    !requested ||
    !existsSync(requested) ||
    isIncompleteManagedLlamaRuntime(requested, options)
  ) {
    await ensureDefaultLlamaRuntimeDownloaded(options);
  }
  const serverPath =
    requested && existsSync(requested) ? requested : defaultServerPath(options);
  if (existsSync(serverPath)) return serverPath;
  throw createDetailedError("Bundled llama-server binary is missing.", {
    baseUrl,
    serverPath,
    requestedServerPath: requested,
    toolsDir: resolveToolsDir(options),
    checkedServerPaths: bundledServerCandidates(resolveToolsDir(options)),
    optionSummary: buildOptionSummary(options),
  });
}

/** @param {ServerRuntimeOptions} options */
function requestedServerPath(options) {
  const explicit =
    runtimeOverrideEnv("MANGA_TRANSLATOR_LLAMA_SERVER_PATH", options) ||
    runtimeOverrideEnv("LLAMA_SERVER_PATH", options);
  if (explicit) return explicit;
  const configured = options.serverPath || defaultServerPath(options);
  return isServerRuntimeCompatibleWithModel(configured, options)
    ? configured
    : defaultServerPath(options);
}

/** @param {ServerRuntimeOptions} options */
function emitServerStarting(options) {
  emitRuntimeProgress(
    options,
    "booting",
    "Gemma 서버 시작 중",
    `${resolveConfiguredModelFile(options)} 로드 중`,
    {
      progressMode: "indeterminate",
      installLogLine: "llama-server를 시작합니다.",
    },
  );
}

/** @param {string} serverPath @param {string[]} launchArgs @param {ServerRuntimeOptions} options @returns {RunningServer} */
function spawnServer(serverPath, launchArgs, options) {
  const child = spawn(serverPath, launchArgs, {
    cwd: resolveWorkingDir(options),
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env: buildLlamaServerEnv(serverPath, options),
  });
  const running = {
    child,
    recent: { stdout: "", stderr: "" },
    logStream: createServerLogStream(options, serverPath, launchArgs),
    onAbort: () => terminateChildProcessTree(child),
  };
  options.abortSignal?.addEventListener?.("abort", running.onAbort, {
    once: true,
  });
  bindServerOutput(running, options);
  return running;
}

/** @param {RunningServer} running @param {ServerRuntimeOptions} options */
function bindServerOutput(running, options) {
  const { child, logStream, recent } = running;
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) =>
    recordServerOutput("stdout", chunk, recent, logStream, options),
  );
  child.stderr?.on("data", (chunk) =>
    recordServerOutput("stderr", chunk, recent, logStream, options),
  );
  child.once("exit", () => logStream?.end());
  child.once("error", () => logStream?.end());
}

/** @param {"stdout" | "stderr"} stream @param {unknown} chunk @param {{ stdout: string; stderr: string }} recent @param {import("node:fs").WriteStream | null} logStream @param {ServerRuntimeOptions} options */
function recordServerOutput(stream, chunk, recent, logStream, options) {
  recent[stream] = shrinkBuffer(recent[stream], chunk);
  logStream?.write(`[${stream}] ${chunk}`);
  emitServerInstallLog(options, chunk);
  const line = `[llama:${options.label}:${stream}] ${chunk}`;
  if (stream === "stdout") process.stdout.write(line);
  else process.stderr.write(line);
}

/** @param {string} baseUrl @param {string} serverPath @param {string[]} launchArgs @param {ServerRuntimeOptions} options @param {RunningServer} running */
function awaitServerReady(baseUrl, serverPath, launchArgs, options, running) {
  return Promise.race([
    waitForReadyOrExit(baseUrl, running.child, 1800000, options.abortSignal),
    rejectOnLaunchError(baseUrl, serverPath, launchArgs, options, running),
  ]);
}

/** @param {string} baseUrl @param {string} serverPath @param {string[]} launchArgs @param {ServerRuntimeOptions} options @param {RunningServer} running */
function rejectOnLaunchError(
  baseUrl,
  serverPath,
  launchArgs,
  options,
  running,
) {
  return new Promise((_, reject) => {
    running.child.once("error", (error) =>
      reject(
        buildLaunchError(
          error,
          baseUrl,
          serverPath,
          launchArgs,
          options,
          running.recent,
        ),
      ),
    );
  });
}

/** @param {unknown} cause @param {string} baseUrl @param {string} serverPath @param {string[]} launchArgs @param {ServerRuntimeOptions} options @param {{ stdout: string; stderr: string }} recent */
function buildLaunchError(
  cause,
  baseUrl,
  serverPath,
  launchArgs,
  options,
  recent,
) {
  return createDetailedError(
    "Failed to launch llama-server.",
    startupErrorDetail(baseUrl, serverPath, launchArgs, options, recent),
    cause,
  );
}

/** @param {string} baseUrl @param {string} serverPath @param {string[]} launchArgs @param {ServerRuntimeOptions} options @param {{ stdout: string; stderr: string }} recent */
function startupErrorDetail(baseUrl, serverPath, launchArgs, options, recent) {
  return {
    baseUrl,
    serverPath,
    launchArgs,
    optionSummary: buildOptionSummary(options),
    recentStdout: truncateText(recent.stdout.trim(), 4000),
    recentStderr: truncateText(recent.stderr.trim(), 4000),
  };
}

/** @param {unknown} error @param {string} baseUrl @param {string} serverPath @param {string[]} launchArgs @param {ServerRuntimeOptions} options @param {{ stdout: string; stderr: string }} recent */
function normalizeStartupError(
  error,
  baseUrl,
  serverPath,
  launchArgs,
  options,
  recent,
) {
  if (
    (error instanceof Error && error.name === "AbortError") ||
    options.abortSignal?.aborted
  )
    return createAbortError();
  if (hasStartupDetail(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return createDetailedError(
    message,
    startupErrorDetail(baseUrl, serverPath, launchArgs, options, recent),
    error,
  );
}

/** @param {unknown} error */
function hasStartupDetail(error) {
  if (!(error instanceof Error)) return false;
  const detail = /** @type {DetailedError} */ (error);
  return Boolean(detail.serverPath || detail.baseUrl || detail.optionSummary);
}

/** @param {ServerRuntimeOptions} options */
function emitServerReady(options) {
  emitRuntimeProgress(
    options,
    "booting",
    "Gemma 서버 준비 완료",
    `${resolveConfiguredModelFile(options)} 준비 완료`,
    {
      progressMode: "determinate",
      progressPercent: 1,
      installLogLine: "Gemma 서버 준비가 완료되었습니다.",
    },
  );
}

/** @param {StartedServer | null | undefined} server */
async function stopServer(server) {
  if (!server?.child) return;
  const child = server.child;
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  if (process.platform === "win32") terminateChildProcessTree(child);
  else child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5000),
  ]);
  if (!exited) terminateChildProcessTree(child);
}

/** @param {unknown} value */
function isTruthy(value) {
  return ["1", "true", "yes", "y", "on"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

module.exports = { startServer, stopServer };
