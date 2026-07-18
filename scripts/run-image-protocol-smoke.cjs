// @ts-check
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync } = require("node:fs");
const { readFile, rm } = require("node:fs/promises");
const { isAbsolute, join, relative, resolve } = require("node:path");
const { resolveElectronExecutable } = require("./electron-executable.cjs");

const root = join(__dirname, "..");
const electronExe = resolveElectronExecutable(root);
const smokeScript = join(root, "scripts", "smoke-image-protocol.cjs");
const smokeTempRoot = join(
  root,
  ".tmp",
  "image-protocol-smoke",
  `${process.pid}-${Date.now()}`,
);
const userDataDir = join(smokeTempRoot, "electron-user-data");
const resultPath = join(smokeTempRoot, "result.json");

if (!existsSync(electronExe)) {
  throw new Error(`Electron executable is missing: ${electronExe}`);
}

assertPathInsideRoot(smokeTempRoot);
mkdirSync(userDataDir, { recursive: true });

const env = { ...process.env };
env.MGT_IMAGE_PROTOCOL_SMOKE_RESULT_PATH = resultPath;
env.MGT_IMAGE_PROTOCOL_SMOKE_USER_DATA = userDataDir;
delete env.ELECTRON_RUN_AS_NODE;

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  try {
    const child = spawn(electronExe, [smokeScript], {
      cwd: root,
      detached: true,
      env,
      stdio: "ignore",
      windowsHide: true,
    });
    const childError = new Promise((_, reject) => {
      child.once("error", reject);
    });
    child.unref();
    const smokeResult = await Promise.race([
      waitForSmokeResult(resultPath, 30_000),
      childError,
    ]);
    if (!smokeResult.ok) {
      throw new Error(`Image protocol smoke failed: ${smokeResult.message}`);
    }
    console.log(smokeResult.message);
  } finally {
    await delay(500);
    await rm(smokeTempRoot, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    });
  }
}

/**
 * @param {string} filePath
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: boolean; message: string }>}
 */
async function waitForSmokeResult(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(filePath, "utf8"));
      if (
        typeof value === "object" &&
        value !== null &&
        typeof value.ok === "boolean" &&
        typeof value.message === "string"
      ) {
        return value;
      }
      throw new Error("Image protocol smoke returned an invalid result.");
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
    await delay(50);
  }
  throw new Error(`Image protocol smoke timed out after ${timeoutMs}ms.`);
}

/** @param {unknown} error */
function isMissingFileError(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** @param {string} targetPath */
function assertPathInsideRoot(targetPath) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(targetPath);
  const child = relative(resolvedRoot, resolvedTarget);
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`Refusing to clean unexpected smoke path: ${targetPath}`);
  }
}
