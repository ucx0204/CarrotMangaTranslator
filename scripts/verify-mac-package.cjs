#!/usr/bin/env node
// @ts-check

const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  createReadStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require("node:fs");
const { homedir, tmpdir } = require("node:os");
const { basename, join, relative, resolve } = require("node:path");
const { MAC_RUNTIME_MANIFEST } = require("./mac-runtime-manifest.cjs");
const { verifyMacRuntimeSmokes } = require("./verify-mac-runtime-smokes.cjs");

const root = join(__dirname, "..");
const distDir = join(root, "dist");

/** @typedef {{ status: number | null; stdout: string; stderr: string; error?: Error }} CommandResult */

/** @param {string} command @param {string[]} args @param {{ env?: NodeJS.ProcessEnv; input?: string; timeout?: number }} [options] @returns {CommandResult} */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.env ? { ...process.env, ...options.env } : process.env,
    input: options.input,
    shell: false,
    timeout: options.timeout,
  });
  const normalized = {
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    ...(result.error ? { error: result.error } : {}),
  };
  if (normalized.error || normalized.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${normalized.error?.message || normalized.stderr || `exit ${normalized.status}`}`,
    );
  }
  return normalized;
}

/** @param {string} directory @returns {string[]} */
function listFiles(directory) {
  /** @type {string[]} */
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

/** @param {string} directory @returns {string[]} */
function findAppBundles(directory) {
  /** @type {string[]} */
  const apps = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.endsWith(".app")) {
      apps.push(entryPath);
    } else {
      apps.push(...findAppBundles(entryPath));
    }
  }
  return apps;
}

/** @param {string} filePath */
function looksLikeNativeBinary(filePath) {
  const metadata = lstatSync(filePath);
  return (
    (metadata.mode & 0o111) !== 0 ||
    /\.(?:dylib|so|node)$/i.test(filePath) ||
    filePath.includes(`${join("Contents", "Frameworks")}`)
  );
}

/** @param {string} filePath */
function requiresOtoolAlias(filePath) {
  return /[()]/.test(filePath);
}

/**
 * otool-classic interprets a trailing parenthesized filename segment such as
 * "Helper (GPU)" as the archive(member) syntax. Inspect the same Mach-O through
 * a parenthesis-free symlink so the tool receives an unambiguous path.
 *
 * @param {string} filePath
 */
function runOtool(filePath) {
  if (!requiresOtoolAlias(filePath)) {
    return run("otool", ["-L", filePath]);
  }
  const aliasRoot = mkdtempSync(join(tmpdir(), "mgt-otool-"));
  const aliasPath = join(aliasRoot, "native-payload");
  try {
    symlinkSync(filePath, aliasPath);
    return run("otool", ["-L", aliasPath]);
  } finally {
    rmSync(aliasRoot, { recursive: true, force: true });
  }
}

/** @param {string} appPath @returns {string[]} */
function verifyNativePayload(appPath) {
  const files = listFiles(appPath);
  const forbidden = files.filter((filePath) =>
    /\.(?:exe|dll)$/i.test(filePath),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Windows payload found in macOS app: ${forbidden.join(", ")}`,
    );
  }

  /** @type {string[]} */
  const machOFiles = [];
  for (const filePath of files.filter(looksLikeNativeBinary)) {
    const description = run("file", ["-b", filePath]).stdout.trim();
    if (!description.includes("Mach-O")) {
      continue;
    }
    if (!/arm64/i.test(description) || /x86_64/i.test(description)) {
      throw new Error(`Non-arm64 Mach-O found: ${filePath}: ${description}`);
    }
    runOtool(filePath);
    run("codesign", ["--verify", "--strict", "--verbose=2", filePath]);
    machOFiles.push(filePath);
  }
  if (machOFiles.length === 0) {
    throw new Error(`No Mach-O payload found in ${appPath}`);
  }
  console.log(
    `[mac-verify] verified ${machOFiles.length} arm64 signed Mach-O files`,
  );
  return machOFiles;
}

/** @param {string} appPath */
function verifyRequiredRuntimes(appPath) {
  const toolsDir = join(appPath, "Contents", "Resources", "tools");
  for (const runtime of MAC_RUNTIME_MANIFEST.llamaRuntimes) {
    const server = join(toolsDir, runtime.id, "llama-server");
    if (!existsSync(server)) {
      throw new Error(`Missing bundled Gemma runtime: ${server}`);
    }
    const result = run(server, ["--list-devices"], { timeout: 60_000 });
    const output = `${result.stdout}\n${result.stderr}`;
    if (!/(?:Metal|Apple)/i.test(output)) {
      throw new Error(
        `${runtime.id} did not report an Apple Metal device: ${output}`,
      );
    }
  }

  const python = join(toolsDir, "python", "bin", "python3");
  if (!existsSync(python)) {
    throw new Error(`Missing bundled OCR Python: ${python}`);
  }
  run(
    python,
    [
      "-c",
      "import importlib.metadata, platform, paddle, paddleocr; assert platform.machine() == 'arm64'; assert paddle.__version__ == '3.3.1'; assert importlib.metadata.version('paddleocr') == '3.7.0'; print('Paddle OCR CPU runtime ok')",
    ],
    {
      timeout: 120_000,
      env: {
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONPYCACHEPREFIX: join(
          tmpdir(),
          "mgt-paddle-package-verify-pycache",
        ),
        PADDLE_PDX_CACHE_HOME: join(tmpdir(), "mgt-paddle-package-verify"),
      },
    },
  );

  const ffmpeg = join(toolsDir, "ffmpeg", "ffmpeg");
  run(ffmpeg, ["-version"], { timeout: 30_000 });

  const runner = join(
    toolsDir,
    "mgt-koharu-inpaint-runner",
    "mgt-koharu-inpaint-runner",
  );
  if (!existsSync(runner)) {
    throw new Error(`Missing bundled Metal inpainting runner: ${runner}`);
  }
  const capabilities = run(runner, ["--capabilities"], { timeout: 60_000 });
  const capabilityText = capabilities.stdout.trim();
  if (
    !/metal/i.test(capabilityText) ||
    !/lama-manga/i.test(capabilityText) ||
    !/aot-inpainting/i.test(capabilityText)
  ) {
    throw new Error(
      `Incomplete Metal inpainting capabilities: ${capabilityText}`,
    );
  }
  const fluxRunner = join(toolsDir, "mgt-flux-klein", "mgt-flux-klein");
  if (!existsSync(fluxRunner)) {
    throw new Error(`Missing bundled Flux Metal runner: ${fluxRunner}`);
  }
  const fluxCapabilities = run(fluxRunner, ["--capabilities"], {
    timeout: 60_000,
  }).stdout.trim();
  if (
    !/metal/i.test(fluxCapabilities) ||
    !/flux-klein/i.test(fluxCapabilities)
  ) {
    throw new Error(`Incomplete Flux Metal capabilities: ${fluxCapabilities}`);
  }
  const protocolSmoke = run(fluxRunner, ["--protocol-smoke"], {
    input: `${JSON.stringify({ type: "shutdown" })}\n`,
    timeout: 60_000,
  }).stdout.trim();
  const protocolResult = JSON.parse(protocolSmoke);
  if (
    protocolResult.ok !== true ||
    protocolResult.protocol_version !== 1 ||
    protocolResult.request !== "shutdown" ||
    protocolResult.backend !== "metal-native"
  ) {
    throw new Error(`Flux worker protocol smoke failed: ${protocolSmoke}`);
  }
}

/** @param {string} appPath */
function verifySigning(appPath) {
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  const details = run("codesign", ["-dvvv", appPath]).stderr;
  if (process.env.MGT_MAC_SIGNING_MODE === "developer-id") {
    if (!/Authority=Developer ID Application/m.test(details)) {
      throw new Error(`Expected Developer ID signature, got:\n${details}`);
    }
    run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
    run("xcrun", ["stapler", "validate", appPath]);
  } else if (!/Signature=adhoc/m.test(details)) {
    throw new Error(`Expected ad-hoc signature, got:\n${details}`);
  }
}

/** @param {string} appPath */
function verifyApplicationDirectorySmoke(appPath) {
  const smokeApp = "/Applications/CarrotMangaTranslatorAlphaSmoke.app";
  if (
    resolve(smokeApp) !== "/Applications/CarrotMangaTranslatorAlphaSmoke.app"
  ) {
    throw new Error(`Unsafe smoke app path: ${smokeApp}`);
  }
  rmSync(smokeApp, { recursive: true, force: true });
  const dataRoot = join(
    homedir(),
    "Library",
    "Application Support",
    "manga-gemma-translator",
  );
  const marker = join(dataRoot, "mac-package-smoke.json");
  rmSync(marker, { force: true });
  try {
    run("ditto", [appPath, smokeApp]);
    const executable = join(
      smokeApp,
      "Contents",
      "MacOS",
      "CarrotMangaTranslator",
    );
    run(executable, [], {
      timeout: 120_000,
      env: {
        MGT_MAC_PACKAGE_SMOKE_EXIT: "1",
        MGT_MAC_PACKAGE_SMOKE_STAGE: "prepare",
      },
    });
    if (!existsSync(marker)) {
      throw new Error(
        `Packaged app did not create its external data marker: ${marker}`,
      );
    }
    const prepared = JSON.parse(readFileSync(marker, "utf8"));
    if (
      prepared.ok !== true ||
      prepared.stage !== "prepared" ||
      prepared.imported !== true ||
      prepared.saved !== true ||
      prepared.exported !== true
    ) {
      throw new Error(
        `Invalid packaged prepare smoke result: ${JSON.stringify(prepared)}`,
      );
    }
    run(executable, [], {
      timeout: 120_000,
      env: {
        MGT_MAC_PACKAGE_SMOKE_EXIT: "1",
        MGT_MAC_PACKAGE_SMOKE_STAGE: "verify",
      },
    });
    const smoke = JSON.parse(readFileSync(marker, "utf8"));
    if (
      smoke.ok !== true ||
      smoke.stage !== "verified" ||
      smoke.platform !== "darwin" ||
      smoke.arch !== "arm64" ||
      smoke.imported !== true ||
      smoke.saved !== true ||
      smoke.restarted !== true ||
      smoke.exported !== true ||
      !String(smoke.dataRoot || "").includes(
        `${join("Library", "Application Support", "manga-gemma-translator")}`,
      ) ||
      String(smoke.dataRoot || "").startsWith("/Applications/")
    ) {
      throw new Error(
        `Invalid packaged data root smoke result: ${JSON.stringify(smoke)}`,
      );
    }
    run("codesign", ["--verify", "--deep", "--strict", smokeApp]);
  } finally {
    rmSync(smokeApp, { recursive: true, force: true });
    rmSync(marker, { force: true });
  }
}

/** @param {string} filePath @returns {Promise<string>} */
async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("macOS package verification requires macOS arm64.");
  }
  const apps = findAppBundles(distDir);
  if (apps.length !== 1) {
    throw new Error(`Expected one unpacked .app in dist, found ${apps.length}`);
  }
  const appPath = apps[0];
  verifyNativePayload(appPath);
  // Establish that electron-builder produced a valid sealed bundle before
  // running any executable from it.  The second check below proves that the
  // runtime smokes kept the signed .app immutable.
  verifySigning(appPath);
  verifyRequiredRuntimes(appPath);
  await verifyMacRuntimeSmokes({ appPath });
  verifySigning(appPath);
  verifyApplicationDirectorySmoke(appPath);

  const dmgFiles = listFiles(distDir).filter((filePath) =>
    filePath.endsWith(".dmg"),
  );
  const zipFiles = listFiles(distDir).filter((filePath) =>
    filePath.endsWith(".zip"),
  );
  if (dmgFiles.length !== 1 || zipFiles.length !== 1) {
    throw new Error(
      `Expected one arm64 DMG and ZIP, found DMG=${dmgFiles.length} ZIP=${zipFiles.length}`,
    );
  }
  run("hdiutil", ["verify", dmgFiles[0]], { timeout: 120_000 });
  if (process.env.MGT_MAC_SIGNING_MODE === "developer-id") {
    run("xcrun", ["stapler", "validate", dmgFiles[0]]);
  }

  const artifacts = [...dmgFiles, ...zipFiles];
  const sums = (
    await Promise.all(
      artifacts.map(
        async (filePath) => `${await sha256(filePath)}  ${basename(filePath)}`,
      ),
    )
  ).join("\n");
  const checksumPath = join(distDir, "SHA256SUMS-mac-alpha.txt");
  writeFileSync(checksumPath, `${sums}\n`, "utf8");
  console.log(
    `[mac-verify] verified ${relative(root, appPath)} and wrote ${relative(root, checksumPath)}`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  findAppBundles,
  listFiles,
  looksLikeNativeBinary,
  requiresOtoolAlias,
};
