const http = require("node:http");
const net = require("node:net");
const { join } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { ensureElectronExecutable } = require("./electron-executable.cjs");
const {
  resolveMissingMacInpaintingRunners,
} = require("./mac-inpainting-runners.cjs");
const { prepareRuntimeAssets } = require("./prepare-runtime.cjs");

const root = join(__dirname, "..");
const DEFAULT_RENDERER_PORT = 5173;
const devStorageRoot = join(root, ".tmp", "electron-dev");
const devSessionData = join(
  devStorageRoot,
  `session-${process.pid}-${Date.now()}`,
);
/** @type {import("node:child_process").ChildProcess[]} */
const children = [];
let shuttingDown = false;

delete process.env.ELECTRON_RUN_AS_NODE;

/** @param {string} message */
function log(message) {
  console.log(`[dev] ${message}`);
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
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    for (const other of children) {
      if (
        other !== child &&
        other.exitCode === null &&
        other.signalCode === null
      ) {
        other.kill();
      }
    }
    process.exit(code ?? 1);
  });
  child.on("error", (error) => {
    console.error(`[dev] failed to start ${label}:`, error);
    if (!shuttingDown) {
      shuttingDown = true;
      shutdown(1);
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

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function shutdown(exitCode = 0) {
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
  process.exit(exitCode);
}

(async () => {
  prepareMacInpaintingRunners();
  log("preparing runtime assets");
  prepareRuntimeAssets({ root, outputDir: join(root, "out", "app-runtime") });
  log("compiling Electron main process");
  runSync(process.execPath, [join(__dirname, "compile-electron.cjs")]);
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
  shutdown(1);
});
