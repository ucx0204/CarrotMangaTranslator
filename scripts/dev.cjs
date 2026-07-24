const http = require("node:http");
const net = require("node:net");
const {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { ensureElectronExecutable } = require("./electron-executable.cjs");
const {
  resolveMissingMacInpaintingRunners,
} = require("./mac-inpainting-runners.cjs");
const { prepareRuntimeAssets } = require("./prepare-runtime.cjs");
const {
  createElectronCompileCacheStep,
  createRuntimeAssetsCacheStep,
  runCachedBuildStep,
} = require("./dev-build-cache.cjs");
const { createDevChildLifecycle } = require("./dev-child-lifecycle.cjs");

const root = join(__dirname, "..");
const DEFAULT_RENDERER_PORT = 5173;
const DEV_LOCK_WRITE_GRACE_MS = 5000;
const devStorageRoot = join(root, ".tmp", "electron-dev");
const devLockPath = join(devStorageRoot, "dev.lock");
const devLockToken = `${process.pid}-${Date.now()}`;
const devSessionData = join(devStorageRoot, "session-data");
/** @type {import("node:child_process").ChildProcess[]} */
const children = [];
/** @type {number | null} */
let devLockFd = null;

/** @typedef {{ pid: number, startedAt: string, token: string }} DevLockHolder */

delete process.env.ELECTRON_RUN_AS_NODE;

/** Acquire the repository-local development lock before touching session data. */
function acquireDevLock() {
  mkdirSync(devStorageRoot, { recursive: true });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      devLockFd = openSync(devLockPath, "wx");
      writeDevLock();
      return;
    } catch (error) {
      if (getErrorCode(error) !== "EEXIST") {
        throw error;
      }
      const holder = readDevLockHolder();
      if (holder && isProcessAlive(holder.pid)) {
        throw new Error(
          `Another npm run dev is already active (PID ${holder.pid}). Stop it before starting a second development instance.`,
          { cause: error },
        );
      }
      if (!holder && isFreshDevLock()) {
        throw new Error(
          "A development instance is currently creating its lock. Retry after the other startup finishes.",
          { cause: error },
        );
      }
      removeStaleDevLock();
    }
  }
  throw new Error("Could not acquire the development-instance lock.");
}

/** Write a validated ownership record into the exclusively created lock. */
function writeDevLock() {
  if (devLockFd === null) {
    throw new Error("Cannot write a development lock before acquiring it.");
  }
  try {
    writeFileSync(
      devLockFd,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        token: devLockToken,
      }),
    );
  } catch (error) {
    rollbackFailedDevLockCreation();
    throw error;
  }
}

/** Close and remove an incompletely written lock before surfacing the failure. */
function rollbackFailedDevLockCreation() {
  if (devLockFd !== null) {
    try {
      closeSync(devLockFd);
    } catch (error) {
      console.warn("[dev] failed to close an incomplete lock:", error);
    } finally {
      devLockFd = null;
    }
  }
  try {
    removeStaleDevLock();
  } catch (error) {
    console.warn("[dev] failed to remove an incomplete lock:", error);
  }
}

/** @returns {DevLockHolder | null} */
function readDevLockHolder() {
  try {
    /** @type {unknown} */
    const parsed = JSON.parse(readFileSync(devLockPath, "utf8"));
    if (!isDevLockHolder(parsed)) {
      console.warn(`[dev] found an invalid lock record at ${devLockPath}`);
      return null;
    }
    return parsed;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      console.warn(
        `[dev] found a malformed lock record at ${devLockPath}: ${error.message}`,
      );
      return null;
    }
    throw error;
  }
}

/**
 * @param {unknown} value
 * @returns {value is DevLockHolder}
 */
function isDevLockHolder(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    "pid" in value &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    "startedAt" in value &&
    typeof value.startedAt === "string" &&
    "token" in value &&
    typeof value.token === "string" &&
    value.token.length > 0
  );
}

/** @returns {boolean} */
function isFreshDevLock() {
  try {
    return Date.now() - statSync(devLockPath).mtimeMs < DEV_LOCK_WRITE_GRACE_MS;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** @param {number} pid */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      return true;
    }
    throw error;
  }
}

/** Remove a stale lock while treating a racing remover as a retry. */
function removeStaleDevLock() {
  try {
    unlinkSync(devLockPath);
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

/** Release only a lock record still owned by this development process. */
function releaseDevLock() {
  if (devLockFd !== null) {
    try {
      closeSync(devLockFd);
    } catch (error) {
      console.warn("[dev] failed to close the development lock:", error);
    } finally {
      devLockFd = null;
    }
  }
  try {
    const holder = readDevLockHolder();
    if (holder && holder.token === devLockToken) {
      unlinkSync(devLockPath);
    }
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      console.warn("[dev] failed to remove the development lock:", error);
    }
  }
}

/**
 * @param {unknown} error
 * @returns {string | null}
 */
function getErrorCode(error) {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    typeof error.code !== "string"
  ) {
    return null;
  }
  return error.code;
}

/** @param {string} message */
function log(message) {
  console.log(`[dev] ${message}`);
}

const devChildLifecycle = createDevChildLifecycle({
  children,
  exit: (code) => process.exit(code),
  log,
});

/**
 * @param {number} exitCode
 * @param {import("node:child_process").ChildProcess | null} [excludedChild]
 */
function requestShutdown(exitCode, excludedChild = null) {
  void devChildLifecycle.shutdown(exitCode, excludedChild).catch((error) => {
    console.error("[dev] child shutdown failed:", error);
    process.exitCode = exitCode || 1;
  });
}

/**
 * @param {string} command
 * @param {string[]} args
 */
function runSync(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

/**
 * @param {string} label
 * @param {import("./dev-build-cache.cjs").CachedBuildStep} step
 * @param {() => void} build
 */
function runDevBuildStep(label, step, build) {
  runCachedBuildStep(step, build, (plan) => {
    log(`${label}: ${plan.decision} (${plan.reason})`);
  });
}

function prepareMacInpaintingRunners() {
  const missing = resolveMissingMacInpaintingRunners(root);
  if (missing.length === 0) return;
  log(`building ${missing.length} missing Metal inpainting runner(s)`);
  runSync(process.execPath, [join(__dirname, "build-mac-runners.cjs")]);
  const remaining = resolveMissingMacInpaintingRunners(root);
  if (remaining.length > 0) {
    throw new Error(
      `Metal inpainting runner build completed without: ${remaining.join(", ")}`,
    );
  }
}

/**
 * @param {string} label
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
function spawnChild(label, command, args, env = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const mergedEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(mergedEnv)) {
    if (value === undefined) {
      delete mergedEnv[key];
    }
  }

  log(`starting ${label}`);
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    env: mergedEnv,
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    log(
      `${label} exited${code === null ? "" : ` code=${code}`}${signal ? ` signal=${signal}` : ""}`,
    );
    if (devChildLifecycle.isShuttingDown()) {
      return;
    }
    requestShutdown(code ?? 1, child);
  });
  child.on("error", (error) => {
    console.error(`[dev] failed to start ${label}:`, error);
    if (!devChildLifecycle.isShuttingDown()) {
      requestShutdown(1, child);
    }
  });
  return child;
}

/**
 * @param {string} url
 * @param {number} [timeoutMs]
 */
async function waitForUrl(url, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await canReach(url)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/**
 * @param {string} url
 * @returns {Promise<boolean>}
 */
function canReach(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      const statusCode = res.statusCode ?? 0;
      resolve(statusCode >= 200 && statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * @param {number} startPort
 * @param {string} [host]
 * @param {number} [maxAttempts]
 * @returns {Promise<number>}
 */
async function findAvailablePort(
  startPort,
  host = "127.0.0.1",
  maxAttempts = 50,
) {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = startPort + offset;
    if (await canListen(host, port)) {
      return port;
    }
  }
  throw new Error(
    `No available renderer dev server port found from ${startPort}`,
  );
}

/**
 * @param {string} host
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function canListen(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close((error) => resolve(!error));
    });
  });
}

/**
 * @param {string} packageName
 * @param {...string} parts
 */
function nodeBin(packageName, ...parts) {
  return join(root, "node_modules", packageName, ...parts);
}

process.on("SIGINT", () => requestShutdown(0));
process.on("SIGTERM", () => requestShutdown(0));
process.on("exit", releaseDevLock);

(async () => {
  acquireDevLock();
  prepareMacInpaintingRunners();
  const runtimeOutputDir = join(root, "out", "app-runtime");
  runDevBuildStep(
    "runtime assets",
    createRuntimeAssetsCacheStep(root, runtimeOutputDir),
    () => prepareRuntimeAssets({ root, outputDir: runtimeOutputDir }),
  );
  runDevBuildStep(
    "Electron main process",
    createElectronCompileCacheStep(root),
    () => runSync(process.execPath, [join(__dirname, "compile-electron.cjs")]),
  );
  const rendererPort = await findAvailablePort(
    Number(process.env.MANGA_TRANSLATOR_DEV_PORT) || DEFAULT_RENDERER_PORT,
  );
  const rendererUrl = `http://127.0.0.1:${rendererPort}`;
  spawnChild("vite", process.execPath, [
    nodeBin("vite", "bin", "vite.js"),
    "--config",
    "vite.renderer.config.ts",
    "--host",
    "127.0.0.1",
    "--port",
    String(rendererPort),
    "--strictPort",
  ]);
  log(`waiting for renderer ${rendererUrl}`);
  await waitForUrl(rendererUrl);
  const electronExe = ensureElectronExecutable(root);
  spawnChild("electron", electronExe, ["."], {
    ELECTRON_RENDERER_URL: rendererUrl,
    ELECTRON_RUN_AS_NODE: undefined,
    MANGA_TRANSLATOR_DEV_USER_DATA: join(devStorageRoot, "user-data"),
    MANGA_TRANSLATOR_DEV_SESSION_DATA: devSessionData,
  });
})().catch((error) => {
  console.error(error);
  requestShutdown(1);
});
