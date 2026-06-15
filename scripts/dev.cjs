const http = require("node:http");
const net = require("node:net");
const { join } = require("node:path");
const { existsSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const { prepareRuntimeAssets } = require("./prepare-runtime.cjs");

const root = join(__dirname, "..");
const DEFAULT_RENDERER_PORT = 5173;
const devStorageRoot = join(root, ".tmp", "electron-dev");
const devSessionData = join(
  devStorageRoot,
  `session-${process.pid}-${Date.now()}`,
);
const children = [];
let shuttingDown = false;

delete process.env.ELECTRON_RUN_AS_NODE;

function log(message) {
  console.log(`[dev] ${message}`);
}

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

function spawnChild(label, command, args, env = {}) {
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
  child.__devLabel = label;
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

function canReach(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

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

function canListen(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close((error) => resolve(!error));
    });
  });
}

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
  log("preparing runtime assets");
  prepareRuntimeAssets({ root, outputDir: join(root, "out", "app-runtime") });
  log("compiling Electron main process");
  runSync(process.execPath, [
    nodeBin("typescript", "bin", "tsc"),
    "-p",
    "tsconfig.electron.json",
  ]);
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
  const electronExe = nodeBin(
    "electron",
    "dist",
    process.platform === "win32" ? "electron.exe" : "electron",
  );
  if (!existsSync(electronExe)) {
    throw new Error(`Electron executable is missing: ${electronExe}`);
  }
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
