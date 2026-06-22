// @ts-check
/** @typedef {import("./runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {import("./runtime-jsdoc-types").DetailedError} DetailedError */
/**
 * @typedef {RuntimeOptions & {
 *   label?: string | null;
 *   onProgress?: ((progress: Record<string, unknown>) => void) | null;
 *   port?: unknown;
 *   reuseServer?: boolean | null;
 *   serverPath?: string | null;
 * }} ServerRuntimeOptions
 * @typedef {{ baseUrl: string; child: import("node:child_process").ChildProcess | null; startedByScript: boolean; serverLogPath?: string | null }} StartedServer
 * @typedef {{ code: number; stdout: string; stderr: string }} RuntimeProbeResult
 */
const { spawn } = require("node:child_process");
const { createWriteStream, existsSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const { bundledServerCandidates } = require("./resolve-llama-runtime.cjs");
const { sanitizeInstallLogLine } = require("./simple-page-progress.cjs");
const {
  resolveConfiguredModelFile,
} = require("./simple-page-model-config.cjs");
const {
  HF_CHILD_ENV_KEYS,
  NETWORK_CHILD_ENV_KEYS,
  ROCM_CHILD_ENV_KEYS,
  buildWhitelistedChildEnv,
  runtimeOverrideEnv,
  shouldAllowExternalRuntimeOverrides,
} = require("./simple-page-child-env.cjs");
const {
  resolveHfHomeDir,
  resolveHubCacheDir,
  resolveLlamaCppCacheDir,
  resolveWorkingDir,
} = require("./simple-page-cache-paths.cjs");
const {
  defaultServerPath,
  hasRequiredLlamaRuntimeFiles,
  isBuiltInGemmaRuntimeModel,
  missingRequiredLlamaRuntimeFiles,
  resolvePreferredLlamaRuntime,
  resolveToolsDir,
} = require("./simple-page-runtime-paths.cjs");
const {
  createAbortError,
  shrinkBuffer,
  terminateChildProcessTree,
} = require("./simple-page-shell-utils.cjs");
const {
  ensureDefaultLlamaRuntimeDownloaded,
  ensureHfModelAssetsDownloaded,
  inspectModelLaunch,
} = require("./simple-page-model-assets.cjs");
const { buildOptionSummary } = require("./simple-page-request-summary.cjs");
const {
  buildLaunchArgs,
  isServerRuntimeCompatibleWithModel,
  looksLikeGemma4Model,
} = require("./simple-page-launch-args.cjs");
const {
  createDetailedError,
  emitRuntimeProgress,
  truncateText,
} = require("./simple-page-runtime-common.cjs");

/** @param {unknown} value */
function isTruthy(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(text);
}

/**
 * @param {string} serverPath
 * @param {ServerRuntimeOptions} options
 * @returns {NodeJS.ProcessEnv}
 */
function buildLlamaServerEnv(serverPath, options = {}) {
  const preferredRuntime = resolvePreferredLlamaRuntime(options);
  const backend = String(preferredRuntime.backend || "cuda").toLowerCase();
  const rocmPath =
    runtimeOverrideEnv("ROCM_PATH", options) ||
    process.env.ROCM_PATH ||
    (process.platform === "win32" ? "" : "/opt/rocm");
  const hipPath =
    runtimeOverrideEnv("HIP_PATH", options) || process.env.HIP_PATH || rocmPath;
  /** @type {Array<string | null>} */
  const pathDirs = [path.dirname(serverPath)];
  if (backend === "rocm" || backend === "hip") {
    pathDirs.push(
      rocmPath ? path.join(rocmPath, "bin") : null,
      rocmPath ? path.join(rocmPath, "llvm", "bin") : null,
      hipPath ? path.join(hipPath, "bin") : null,
    );
  }
  const env = buildWhitelistedChildEnv({
    pathDirs,
    includeProcessPath: shouldAllowExternalRuntimeOverrides(options),
    extraKeys: [
      ...NETWORK_CHILD_ENV_KEYS,
      ...HF_CHILD_ENV_KEYS,
      ...(backend === "rocm" || backend === "hip" ? ROCM_CHILD_ENV_KEYS : []),
    ],
  });
  const hfHomeDir = resolveHfHomeDir(options);
  const hfHubCacheDir = resolveHubCacheDir(options);
  const llamaCacheDir = resolveLlamaCppCacheDir(options);
  if (hfHomeDir) {
    env.HF_HOME = hfHomeDir;
  }
  if (hfHubCacheDir) {
    env.HF_HUB_CACHE = hfHubCacheDir;
    env.HUGGINGFACE_HUB_CACHE = hfHubCacheDir;
  }
  if (llamaCacheDir) {
    try {
      mkdirSync(llamaCacheDir, { recursive: true });
    } catch (_error) {
      // llama-server can still use its own fallback if the cache directory cannot be created.
    }
    env.LLAMA_CACHE = llamaCacheDir;
    env.LLAMA_CACHE_DIR = llamaCacheDir;
  }
  if ((backend === "rocm" || backend === "hip") && rocmPath) {
    env.ROCM_PATH = env.ROCM_PATH || rocmPath;
    env.HIP_PATH = env.HIP_PATH || hipPath || rocmPath;
    if (process.platform !== "win32") {
      env.LD_LIBRARY_PATH = [
        env.LD_LIBRARY_PATH,
        path.join(rocmPath, "lib"),
        path.join(rocmPath, "lib64"),
      ]
        .filter(Boolean)
        .join(":");
    }
  }
  env.MANGA_TRANSLATOR_LLAMA_PORT = String(options.port);
  return env;
}

/**
 * @param {string} baseUrl
 * @returns {Promise<boolean>}
 */
async function isReachable(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(2500),
    });
    return response.ok;
  } catch (_error) {
    return false;
  }
}

/**
 * @param {string} baseUrl
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} [timeoutMs]
 * @param {AbortSignal | null} [signal]
 */
async function waitForReadyOrExit(
  baseUrl,
  child,
  timeoutMs = 1800000,
  /** @type {AbortSignal | null} */
  signal = null,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `llama-server exited before becoming ready (code=${child.exitCode ?? "null"}, signal=${child.signalCode ?? "null"})`,
      );
    }
    if (await isReachable(baseUrl)) {
      return;
    }
    await delay(1500);
  }
  throw new Error(`Timed out while waiting for llama-server at ${baseUrl}`);
}

/**
 * @param {ServerRuntimeOptions} options
 * @returns {Promise<StartedServer>}
 */
async function startServer(options) {
  const baseUrl = `http://127.0.0.1:${options.port}/v1`;
  if (
    options.reuseServer &&
    shouldAllowExistingLlamaServerReuse(options) &&
    (await isReachable(baseUrl))
  ) {
    return { baseUrl, child: null, startedByScript: false };
  }

  const explicitServerPath =
    runtimeOverrideEnv("MANGA_TRANSLATOR_LLAMA_SERVER_PATH", options) ||
    runtimeOverrideEnv("LLAMA_SERVER_PATH", options);
  const configuredServerPath = options.serverPath || defaultServerPath(options);
  const requestedServerPath =
    explicitServerPath ||
    (isServerRuntimeCompatibleWithModel(configuredServerPath, options)
      ? configuredServerPath
      : defaultServerPath(options));
  if (
    !requestedServerPath ||
    !existsSync(requestedServerPath) ||
    isIncompleteManagedLlamaRuntime(requestedServerPath, options)
  ) {
    await ensureDefaultLlamaRuntimeDownloaded(options);
  }
  const resolvedBundledServerPath = defaultServerPath(options);
  const serverPath =
    requestedServerPath && existsSync(requestedServerPath)
      ? requestedServerPath
      : resolvedBundledServerPath;
  if (!existsSync(serverPath)) {
    throw createDetailedError("Bundled llama-server binary is missing.", {
      baseUrl,
      serverPath,
      requestedServerPath,
      toolsDir: resolveToolsDir(options),
      checkedServerPaths: bundledServerCandidates(resolveToolsDir(options)),
      optionSummary: buildOptionSummary(options),
    });
  }

  await verifyLlamaRuntimePreflight(serverPath, options);
  const childEnv = buildLlamaServerEnv(serverPath, options);

  const launchTarget = inspectModelLaunch(options);
  if (launchTarget.requiresDownload) {
    await ensureHfModelAssetsDownloaded(options, launchTarget);
  }
  const launchArgs = buildLaunchArgs({ ...options, serverPath });
  const serverLogStream = createServerLogStream(
    options,
    serverPath,
    launchArgs,
  );
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
  let recentStdout = "";
  let recentStderr = "";
  const child = spawn(serverPath, launchArgs, {
    cwd: resolveWorkingDir(options),
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env: childEnv,
  });
  const abortSignal = options.abortSignal;
  const onAbort = () => terminateChildProcessTree(child);
  abortSignal?.addEventListener?.("abort", onAbort, { once: true });

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    recentStdout = shrinkBuffer(recentStdout, chunk);
    serverLogStream?.write(`[stdout] ${chunk}`);
    emitServerInstallLog(options, chunk);
    process.stdout.write(`[llama:${options.label}:stdout] ${chunk}`);
  });
  child.stderr?.on("data", (chunk) => {
    recentStderr = shrinkBuffer(recentStderr, chunk);
    serverLogStream?.write(`[stderr] ${chunk}`);
    emitServerInstallLog(options, chunk);
    process.stderr.write(`[llama:${options.label}:stderr] ${chunk}`);
  });
  child.once("exit", () => serverLogStream?.end());
  child.once("error", () => serverLogStream?.end());

  try {
    await Promise.race([
      waitForReadyOrExit(baseUrl, child, 1800000, abortSignal),
      new Promise((_, reject) => {
        child.once("error", (error) => {
          reject(
            createDetailedError(
              "Failed to launch llama-server.",
              {
                baseUrl,
                serverPath,
                launchArgs,
                optionSummary: buildOptionSummary(options),
                recentStdout: truncateText(recentStdout.trim(), 4000),
                recentStderr: truncateText(recentStderr.trim(), 4000),
              },
              error,
            ),
          );
        });
      }),
    ]);
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
  } catch (error) {
    terminateChildProcessTree(child);
    if (
      (error instanceof Error && error.name === "AbortError") ||
      abortSignal?.aborted
    ) {
      throw createAbortError();
    }
    const detailedError =
      error instanceof Error ? /** @type {DetailedError} */ (error) : null;
    if (
      detailedError &&
      (detailedError.serverPath ||
        detailedError.baseUrl ||
        detailedError.optionSummary)
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw createDetailedError(
      message,
      {
        baseUrl,
        serverPath,
        launchArgs,
        optionSummary: buildOptionSummary(options),
        recentStdout: truncateText(recentStdout.trim(), 4000),
        recentStderr: truncateText(recentStderr.trim(), 4000),
      },
      error,
    );
  } finally {
    abortSignal?.removeEventListener?.("abort", onAbort);
  }

  return {
    baseUrl,
    child,
    startedByScript: true,
    serverLogPath: options.serverLogPath,
  };
}

/** @param {RuntimeOptions} [options] */
function shouldAllowExistingLlamaServerReuse(options = {}) {
  return isTruthy(
    runtimeOverrideEnv("MGT_ALLOW_LLAMA_SERVER_REUSE", options) ??
      runtimeOverrideEnv("MANGA_TRANSLATOR_ALLOW_LLAMA_SERVER_REUSE", options),
  );
}

/**
 * @param {string | null | undefined} serverPath
 * @param {RuntimeOptions} [options]
 */
function isIncompleteManagedLlamaRuntime(serverPath, options = {}) {
  if (!serverPath || !isBuiltInGemmaRuntimeModel(options)) {
    return false;
  }
  const preferredRuntime = resolvePreferredLlamaRuntime(options);
  const runtimeDir = path.dirname(serverPath);
  if (
    path.basename(runtimeDir).toLowerCase() !==
    preferredRuntime.dir.toLowerCase()
  ) {
    return false;
  }
  return !hasRequiredLlamaRuntimeFiles(runtimeDir, preferredRuntime);
}

/**
 * @param {string} serverPath
 * @param {RuntimeOptions} [options]
 */
async function verifyLlamaRuntimePreflight(serverPath, options = {}) {
  if (!looksLikeGemma4Model(options)) {
    return;
  }
  const preferredRuntime = resolvePreferredLlamaRuntime(options);
  const runtimeDir = path.dirname(serverPath);
  if (
    path.basename(runtimeDir).toLowerCase() ===
    preferredRuntime.dir.toLowerCase()
  ) {
    const missingFiles = missingRequiredLlamaRuntimeFiles(
      runtimeDir,
      preferredRuntime,
    );
    if (missingFiles.length > 0) {
      throw createDetailedError(
        "Gemma 실행 런타임이 불완전합니다. GPU 런타임 파일을 포함해 다시 설치해야 합니다.",
        {
          serverPath,
          runtimeDir,
          runtime: preferredRuntime.id,
          missingFiles,
        },
      );
    }
  }
  const shouldProbe =
    process.platform === "win32" ||
    preferredRuntime.backend === "rocm" ||
    preferredRuntime.backend === "vulkan";
  if (
    !shouldProbe ||
    runtimeOverrideEnv("MGT_SKIP_LLAMA_RUNTIME_PREFLIGHT", options)
  ) {
    return;
  }
  const result = await runLlamaRuntimeProbe(
    serverPath,
    options,
    ["--list-devices"],
    20000,
  );
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0) {
    throw createDetailedError(
      `llama-server ${formatLlamaBackendLabel(preferredRuntime.backend)} 런타임 검증에 실패했습니다.`,
      {
        serverPath,
        runtimeBackend: preferredRuntime.backend,
        code: result.code,
        stdout: truncateText(result.stdout, 4000),
        stderr: truncateText(result.stderr, 4000),
      },
    );
  }
  if (!llamaRuntimeProbeLooksGpuBacked(output, preferredRuntime.backend)) {
    const backendLabel =
      preferredRuntime.backend === "vulkan"
        ? "Vulkan/AMD GPU"
        : preferredRuntime.backend === "rocm"
          ? "ROCm/HIP GPU"
          : "CUDA GPU";
    throw createDetailedError(
      `llama-server가 ${backendLabel}를 찾지 못했습니다. CPU 실행으로 조용히 넘어가지 않도록 중단합니다.`,
      {
        serverPath,
        runtimeBackend: preferredRuntime.backend,
        stdout: truncateText(result.stdout, 4000),
        stderr: truncateText(result.stderr, 4000),
      },
    );
  }
}

/** @param {unknown} [backend] */
function formatLlamaBackendLabel(backend = "cuda") {
  const normalized = String(backend || "cuda").toLowerCase();
  if (normalized === "vulkan") {
    return "Vulkan";
  }
  if (normalized === "rocm" || normalized === "hip") {
    return "ROCm/HIP";
  }
  return "CUDA";
}

/**
 * @param {unknown} output
 * @param {unknown} [backend]
 */
function llamaRuntimeProbeLooksGpuBacked(output, backend = "cuda") {
  const text = String(output || "");
  const normalizedBackend = String(backend || "cuda").toLowerCase();
  if (normalizedBackend === "vulkan") {
    return /(vulkan|radeon|amd|gpu)/i.test(text);
  }
  if (normalizedBackend === "rocm" || normalizedBackend === "hip") {
    return /(rocm|hip|radeon|amd|gpu)/i.test(text);
  }
  return /(cuda|nvidia|geforce|rtx|gpu)/i.test(text);
}

/**
 * @param {string} serverPath
 * @param {RuntimeOptions} [options]
 * @param {string[]} [args]
 * @param {number} [timeoutMs]
 * @returns {Promise<RuntimeProbeResult>}
 */
function runLlamaRuntimeProbe(
  serverPath,
  options = {},
  args = [],
  timeoutMs = 20000,
) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(serverPath, args, {
      cwd: resolveWorkingDir(options),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: buildLlamaServerEnv(serverPath, options),
    });
    const timer = setTimeout(() => {
      terminateChildProcessTree(child);
      resolve({
        code: -1,
        stdout,
        stderr: `${stderr}\nllama-server probe timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout = shrinkBuffer(stdout, chunk, 8000);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = shrinkBuffer(stderr, chunk, 8000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * @param {ServerRuntimeOptions} options
 * @param {string} serverPath
 * @param {string[]} launchArgs
 * @returns {import("node:fs").WriteStream | null}
 */
function createServerLogStream(options, serverPath, launchArgs) {
  const logPath = String(options.serverLogPath ?? "").trim();
  if (!logPath) {
    return null;
  }
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    const stream = createWriteStream(logPath, { flags: "a" });
    stream.write(`# ${new Date().toISOString()}\n`);
    stream.write(`# serverPath=${serverPath}\n`);
    stream.write(`# launchArgs=${launchArgs.join(" ")}\n`);
    return stream;
  } catch (_error) {
    return null;
  }
}

/**
 * @param {ServerRuntimeOptions} options
 * @param {unknown} chunk
 */
function emitServerInstallLog(
  /** @type {ServerRuntimeOptions} */ options = {},
  chunk,
) {
  for (const part of String(chunk ?? "").split(/[\r\n]+/)) {
    const line = sanitizeInstallLogLine(part);
    if (!line) {
      continue;
    }
    emitRuntimeProgress(
      options,
      "booting",
      "Gemma 서버 로그",
      `${resolveConfiguredModelFile(options)} 실행 중`,
      {
        progressMode: "log-only",
        installLogLine: line,
      },
    );
  }
}

/** @param {StartedServer | null | undefined} server */
async function stopServer(server) {
  if (!server?.child) {
    return;
  }
  const child = server.child;
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  if (process.platform === "win32") {
    terminateChildProcessTree(child);
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5000),
  ]);
  if (!exited) {
    terminateChildProcessTree(child);
  }
}

module.exports = {
  buildLaunchArgs,
  buildLlamaServerEnv,
  startServer,
  stopServer,
};
