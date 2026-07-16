#!/usr/bin/env node
const { spawn, spawnSync } = require("node:child_process");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, join, relative, resolve } = require("node:path");
const { WINDOWS_EXECUTABLE_FILENAME } = require("./installer-zip-safety.cjs");

const PRODUCTION_UNINSTALL_REGISTRY_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\458b2abe-509f-58f9-8fa8-dd00ca14cadc";
const root = join(__dirname, "..");
const distDir = join(root, "dist");
const unpackedDir = join(distDir, "win-unpacked");
const packageJson = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
);
const previousInstaller = process.env.MGT_PREVIOUS_INSTALLER;

if (process.platform !== "win32") {
  throw new Error("Windows installer smoke must run on Windows.");
}
if (
  process.env.CI !== "true" &&
  process.env.MGT_ALLOW_LOCAL_INSTALLER_SMOKE !== "1"
) {
  throw new Error(
    "Local installer smoke changes temporary HKCU install state. Set MGT_ALLOW_LOCAL_INSTALLER_SMOKE=1 to confirm.",
  );
}
if (
  process.env.CI !== "true" &&
  process.env.MGT_ALLOW_EXISTING_INSTALLER_SMOKE !== "1" &&
  registryKeyExists(PRODUCTION_UNINSTALL_REGISTRY_KEY)
) {
  throw new Error(
    "A production CarrotMangaTranslator installation is registered. Refusing to replace it during local smoke.",
  );
}

const smokeRoot = mkdtempSync(join(tmpdir(), "mgt-installer-smoke-"));
const installDir = join(smokeRoot, "app");
const dataDir = join(smokeRoot, "data");
const dataPointer = join(installDir, "data-root.txt");
const appExecutable = join(installDir, WINDOWS_EXECUTABLE_FILENAME);
const legacyAppExecutable = join(installDir, "당근망가번역기.exe");
const lockTarget = join(installDir, "chrome_100_percent.pak");
/** @type {string | undefined} */
let uninstaller;

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  let failure;

  try {
    const installer = findInstaller();
    mkdirSync(installDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(dataPointer, `${dataDir}\r\n`, "utf8");

    if (previousInstaller) {
      if (!existsSync(previousInstaller)) {
        throw new Error(
          `Previous installer does not exist: ${previousInstaller}`,
        );
      }
      console.log(
        `[installer-smoke] previous-version install: ${basename(previousInstaller)}`,
      );
      runInstaller(previousInstaller);
      if (!existsSync(legacyAppExecutable)) {
        throw new Error(
          `Previous installer did not create its legacy executable: ${legacyAppExecutable}`,
        );
      }
      console.log(
        `[installer-smoke] upgrade to current: ${basename(installer)}`,
      );
      runInstaller(installer);
      verifyInstalledPayload("previous-version upgrade");
      if (existsSync(legacyAppExecutable)) {
        throw new Error(
          `Legacy executable survived upgrade: ${legacyAppExecutable}`,
        );
      }
    } else {
      console.log(`[installer-smoke] fresh install: ${basename(installer)}`);
      runInstaller(installer);
      verifyInstalledPayload("fresh install");
    }

    console.log(
      "[installer-smoke] upgrade with an early payload file temporarily locked",
    );
    const lockHolder = await holdFileLock(lockTarget, 1_200);
    runInstaller(installer);
    await waitForChild(lockHolder);
    verifyInstalledPayload("locked-file upgrade");

    const sentinel = join(dataDir, "preserve-after-uninstall.txt");
    writeFileSync(sentinel, "preserve me\n", "utf8");
    uninstaller = findUninstaller();
    runProcess(uninstaller, ["/S", "/currentuser"], "uninstaller");
    waitForPathMissing(appExecutable, 30_000);
    uninstaller = undefined;

    if (existsSync(appExecutable)) {
      throw new Error(`App executable survived uninstall: ${appExecutable}`);
    }
    if (!existsSync(sentinel)) {
      throw new Error(`User data was removed by uninstall: ${sentinel}`);
    }
    console.log(
      "[installer-smoke] install/upgrade, locked-file retry, and data-preserving uninstall passed",
    );
  } catch (error) {
    failure = error;
  } finally {
    if (uninstaller && existsSync(uninstaller)) {
      try {
        runProcess(uninstaller, ["/S", "/currentuser"], "cleanup uninstaller");
        waitForPathMissing(appExecutable, 30_000);
      } catch (error) {
        if (failure) {
          console.error(error);
        } else {
          failure = error;
        }
      }
    }
    try {
      safeRemoveSmokeRoot();
    } catch (error) {
      if (failure) {
        console.error(error);
      } else {
        failure = error;
      }
    }
  }

  if (failure) {
    throw failure;
  }
}

function findInstaller() {
  const suffix = ` Setup ${packageJson.version}.exe`;
  const installers = readdirSync(distDir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => join(distDir, name));
  if (installers.length !== 1) {
    throw new Error(
      `Expected exactly one v${packageJson.version} installer, found ${installers.length}.`,
    );
  }
  return installers[0];
}

/**
 * @param {string} installer
 */
function runInstaller(installer) {
  runProcess(
    installer,
    ["/S", "/currentuser", `/D=${installDir}`],
    "installer",
  );
}

/**
 * @param {string} stage
 */
function verifyInstalledPayload(stage) {
  const missing = [];
  const mismatched = [];
  for (const expectedPath of listFiles(unpackedDir)) {
    const relativePath = relative(unpackedDir, expectedPath);
    const installedPath = join(installDir, relativePath);
    if (!existsSync(installedPath)) {
      missing.push(relativePath);
      continue;
    }
    const expectedBytes = statSync(expectedPath).size;
    const installedBytes = statSync(installedPath).size;
    if (installedBytes !== expectedBytes) {
      mismatched.push(
        `${relativePath}: expected ${expectedBytes}, got ${installedBytes}`,
      );
    }
  }

  if (missing.length > 0 || mismatched.length > 0) {
    throw new Error(
      [
        `${stage} produced an incomplete installed payload.`,
        ...missing.slice(0, 20).map((path) => `missing: ${path}`),
        ...mismatched.slice(0, 20).map((entry) => `size mismatch: ${entry}`),
      ].join("\n"),
    );
  }
  if (!existsSync(appExecutable)) {
    throw new Error(`${stage} did not install ${appExecutable}`);
  }
  uninstaller = findUninstaller();

  const installedDataRoot = readFileSync(dataPointer, "utf8").trim();
  if (resolve(installedDataRoot) !== resolve(dataDir)) {
    throw new Error(
      `${stage} changed the isolated data root to ${installedDataRoot}`,
    );
  }
}

function findUninstaller() {
  const uninstallers = readdirSync(installDir)
    .filter((name) => name.startsWith("Uninstall ") && name.endsWith(".exe"))
    .map((name) => join(installDir, name));
  if (uninstallers.length !== 1) {
    throw new Error(
      `Expected exactly one uninstaller, found ${uninstallers.length}.`,
    );
  }
  return uninstallers[0];
}

/**
 * @param {string} executable
 * @param {string[]} args
 * @param {string} label
 */
function runProcess(executable, args, label) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    stdio: "inherit",
    timeout: 300_000,
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} exited with code ${result.status}.`);
  }
}

/**
 * @param {string} key
 */
function registryKeyExists(key) {
  const result = spawnSync("reg.exe", ["query", key], {
    stdio: "ignore",
    windowsHide: true,
  });
  return result.status === 0;
}

/**
 * @param {string} path
 * @param {number} milliseconds
 */
async function holdFileLock(path, milliseconds) {
  const command = [
    "$stream = [IO.File]::Open(",
    "  $env:MGT_LOCK_PATH,",
    "  [IO.FileMode]::Open,",
    "  [IO.FileAccess]::Read,",
    "  [IO.FileShare]::None",
    ")",
    "[Console]::Out.WriteLine('LOCKED')",
    `[Threading.Thread]::Sleep(${milliseconds})`,
    "$stream.Dispose()",
  ].join("\n");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      env: { ...process.env, MGT_LOCK_PATH: path },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  await new Promise((resolveReady, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out while locking ${path}. ${stderr}`));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("LOCKED")) {
        clearTimeout(timeout);
        resolveReady(undefined);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!stdout.includes("LOCKED")) {
        clearTimeout(timeout);
        reject(
          new Error(`File-lock helper exited with code ${code}. ${stderr}`),
        );
      }
    });
  });

  return child;
}

/**
 * @param {import("node:child_process").ChildProcess} child
 */
async function waitForChild(child) {
  if (child.exitCode !== null) {
    if (child.exitCode !== 0) {
      throw new Error(`File-lock helper exited with code ${child.exitCode}.`);
    }
    return;
  }
  await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolveExit(undefined);
      } else {
        reject(new Error(`File-lock helper exited with code ${code}.`));
      }
    });
  });
}

/**
 * @param {string} directory
 * @returns {string[]}
 */
function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function safeRemoveSmokeRoot() {
  const resolvedRoot = resolve(smokeRoot);
  const resolvedTemp = resolve(tmpdir());
  const relativeToTemp = relative(resolvedTemp, resolvedRoot);
  if (
    relativeToTemp === "" ||
    relativeToTemp.startsWith("..") ||
    relativeToTemp.includes(`..${require("node:path").sep}`)
  ) {
    throw new Error(`Refusing to remove unsafe smoke root: ${resolvedRoot}`);
  }
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    try {
      removeTree(resolvedRoot);
      return;
    } catch (error) {
      if (attempt === 40) {
        throw error;
      }
      sleepSync(250);
    }
  }
}

/**
 * Node 24's recursive rm can terminate or return EPERM on some Windows paths.
 * Remove the isolated smoke tree with simple native file operations instead.
 *
 * @param {string} directory
 */
function removeTree(directory) {
  if (!existsSync(directory)) {
    return;
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      removeTree(entryPath);
    } else {
      unlinkSync(entryPath);
    }
  }
  rmdirSync(directory);
}

/**
 * @param {number} milliseconds
 */
function sleepSync(milliseconds) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    milliseconds,
  );
}

/**
 * The electron-builder uninstaller relaunches itself from a temporary copy,
 * so the original process can exit before its cleanup child has finished.
 *
 * @param {string} path
 * @param {number} timeoutMilliseconds
 */
function waitForPathMissing(path, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for uninstall cleanup: ${path}`);
    }
    sleepSync(100);
  }
}
