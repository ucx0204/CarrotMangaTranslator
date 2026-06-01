const http = require("node:http");
const { join } = require("node:path");
const { readdirSync, rmSync, statSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const { prepareRuntimeAssets } = require("./prepare-runtime.cjs");

const root = join(__dirname, "..");
const rendererUrl = "http://127.0.0.1:5173";
const devStorageRoot = join(root, ".tmp", "electron-dev");
const devSessionData = join(devStorageRoot, `session-${process.pid}-${Date.now()}`);
const children = [];

function runSync(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function spawnChild(command, args, env = {}) {
  const mergedEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(mergedEnv)) {
    if (value === undefined) {
      delete mergedEnv[key];
    }
  }

  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    env: mergedEnv
  });
  children.push(child);
  child.on("exit", () => {
    for (const other of children) {
      if (other !== child && other.exitCode === null && other.signalCode === null) {
        other.kill();
      }
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

function nodeBin(packageName, ...parts) {
  return join(root, "node_modules", packageName, ...parts);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
  process.exit(0);
}

(async () => {
  cleanupOldDevSessions();
  prepareRuntimeAssets({ root, outputDir: join(root, "out", "app-runtime") });
  runSync(process.execPath, [nodeBin("typescript", "bin", "tsc"), "-p", "tsconfig.electron.json"]);
  spawnChild(process.execPath, [nodeBin("vite", "bin", "vite.js"), "--config", "vite.renderer.config.ts", "--host", "127.0.0.1"]);
  await waitForUrl(rendererUrl);
  spawnChild(process.execPath, [nodeBin("electron", "cli.js"), "."], {
    ELECTRON_RENDERER_URL: rendererUrl,
    ELECTRON_RUN_AS_NODE: undefined,
    MANGA_TRANSLATOR_DEV_USER_DATA: join(devStorageRoot, "user-data"),
    MANGA_TRANSLATOR_DEV_SESSION_DATA: devSessionData
  });
})().catch((error) => {
  console.error(error);
  shutdown();
});

function cleanupOldDevSessions() {
  const maxAgeMs = 24 * 60 * 60 * 1000;
  try {
    for (const entry of readdirSync(devStorageRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("session-")) {
        continue;
      }
      const fullPath = join(devStorageRoot, entry.name);
      const ageMs = Date.now() - statSync(fullPath).mtimeMs;
      if (ageMs > maxAgeMs) {
        rmSync(fullPath, { recursive: true, force: true });
      }
    }
  } catch {
    // Stale Electron cache directories are best-effort cleanup only.
  }
}
