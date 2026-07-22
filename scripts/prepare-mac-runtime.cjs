#!/usr/bin/env node
// @ts-check

const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createReadStream, createWriteStream, existsSync } = require("node:fs");
const {
  chmod,
  cp,
  lstat,
  mkdir,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
} = require("node:fs/promises");
const https = require("node:https");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const tar = require("tar");
const { MAC_RUNTIME_MANIFEST } = require("./mac-runtime-manifest.cjs");

const root = path.join(__dirname, "..");
const stagingRoot = path.join(root, ".tmp", "mac-runtime");
const stagingTools = path.join(stagingRoot, "tools");
const downloadsRoot = path.join(root, ".tmp", "mac-runtime-downloads");
const extractionRoot = path.join(root, ".tmp", "mac-runtime-work");

/** @typedef {{ id?: string; archive: string; url: string; sha256: string }} ArchiveAsset */

/** @param {string} command @param {string[]} args @param {NodeJS.ProcessEnv} [extraEnv] */
function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with exit code ${result.status ?? "null"}`,
    );
  }
}

/** @param {string} url @returns {Promise<import("node:http").IncomingMessage>} */
function request(url) {
  return new Promise((resolveRequest, rejectRequest) => {
    const outgoing = https.get(
      url,
      { headers: { "User-Agent": "CarrotMangaTranslator-mac-alpha-build" } },
      resolveRequest,
    );
    outgoing.on("error", rejectRequest);
  });
}

/** @param {string} url @param {string} outputPath @param {number} [redirects] */
async function download(url, outputPath, redirects = 0) {
  if (redirects > 8) {
    throw new Error(`Too many redirects while downloading ${url}`);
  }
  const response = await request(url);
  const status = response.statusCode ?? 0;
  if ([301, 302, 303, 307, 308].includes(status)) {
    const location = response.headers.location;
    response.resume();
    if (!location) {
      throw new Error(`Redirect without Location while downloading ${url}`);
    }
    const redirectedUrl = new URL(location, url).toString();
    return download(redirectedUrl, outputPath, redirects + 1);
  }
  if (status !== 200) {
    response.resume();
    throw new Error(`Download failed (${status}) for ${url}`);
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await pipeline(response, createWriteStream(outputPath));
}

/** @param {string} filePath @returns {Promise<string>} */
async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** @param {ArchiveAsset} asset @returns {Promise<string>} */
async function ensureVerifiedDownload(asset) {
  const archivePath = path.join(downloadsRoot, asset.archive);
  if (!existsSync(archivePath)) {
    console.log(`[mac-runtime] downloading ${asset.url}`);
    await download(asset.url, archivePath);
  }
  const actual = await sha256File(archivePath);
  if (actual !== asset.sha256) {
    await rm(archivePath, { force: true });
    throw new Error(
      `SHA-256 mismatch for ${asset.archive}: expected ${asset.sha256}, got ${actual}`,
    );
  }
  return archivePath;
}

/** @param {string} entryPath @param {string} [linkPath] */
function assertSafeArchiveEntry(entryPath, linkPath = "") {
  const normalized = String(entryPath).replace(/\\/g, "/");
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`Unsafe archive entry path: ${entryPath}`);
  }
  if (!linkPath) {
    return;
  }
  const normalizedLink = String(linkPath).replace(/\\/g, "/");
  if (
    path.posix.isAbsolute(normalizedLink) ||
    /^[A-Za-z]:/.test(normalizedLink)
  ) {
    throw new Error(`Unsafe archive link target: ${entryPath} -> ${linkPath}`);
  }
  const resolvedLink = path.posix.normalize(
    path.posix.join(path.posix.dirname(normalized), normalizedLink),
  );
  if (resolvedLink === ".." || resolvedLink.startsWith("../")) {
    throw new Error(
      `Archive link escapes extraction root: ${entryPath} -> ${linkPath}`,
    );
  }
}

/** @param {string} archivePath @param {string} outputDir */
async function extractTarSafely(archivePath, outputDir) {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  /** @type {Array<{ entryPath: string; linkPath: string }>} */
  const symbolicLinks = [];
  await tar.t({
    file: archivePath,
    strict: true,
    onentry(entry) {
      assertSafeArchiveEntry(entry.path, entry.linkpath);
      if (entry.type === "SymbolicLink") {
        symbolicLinks.push({
          entryPath: String(entry.path),
          linkPath: String(entry.linkpath),
        });
      }
    },
  });
  await tar.x({
    file: archivePath,
    cwd: outputDir,
    strict: true,
    preservePaths: false,
    filter(_entryPath, entry) {
      const tarEntry = /** @type {{ type?: string }} */ (entry);
      return tarEntry.type !== "SymbolicLink";
    },
  });
  for (const link of symbolicLinks) {
    const linkPath = path.resolve(outputDir, link.entryPath);
    if (!isSameOrDescendant(outputDir, linkPath)) {
      throw new Error(
        `Refusing to create archive symlink outside root: ${linkPath}`,
      );
    }
    await mkdir(path.dirname(linkPath), { recursive: true });
    await symlink(link.linkPath, linkPath);
  }
  await assertSymlinksStayInside(outputDir, outputDir);
}

/** @param {string} rootDir @param {string} currentDir */
async function assertSymlinksStayInside(rootDir, currentDir) {
  for (const entry of await readdir(currentDir, { withFileTypes: true })) {
    const entryPath = path.join(currentDir, entry.name);
    const metadata = await lstat(entryPath);
    if (metadata.isSymbolicLink()) {
      const target = await readlink(entryPath);
      const resolvedTarget = path.resolve(path.dirname(entryPath), target);
      let realTarget;
      try {
        realTarget = await realpath(entryPath);
      } catch (cause) {
        throw new Error(`Extracted symlink is broken: ${entryPath}`, { cause });
      }
      if (
        !isSameOrDescendant(rootDir, resolvedTarget) ||
        !isSameOrDescendant(rootDir, realTarget)
      ) {
        throw new Error(
          `Extracted symlink escapes root: ${entryPath} -> ${target}`,
        );
      }
    } else if (metadata.isDirectory()) {
      await assertSymlinksStayInside(rootDir, entryPath);
    }
  }
}

/** @param {string} parent @param {string} candidate */
function isSameOrDescendant(parent, candidate) {
  const relativePath = path.relative(
    path.resolve(parent),
    path.resolve(candidate),
  );
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

/** @param {string} currentDir @param {string} basename @returns {Promise<string | null>} */
async function findFile(currentDir, basename) {
  for (const entry of await readdir(currentDir, { withFileTypes: true })) {
    const entryPath = path.join(currentDir, entry.name);
    if ((entry.isFile() || entry.isSymbolicLink()) && entry.name === basename) {
      return entryPath;
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const nested = await findFile(entryPath, basename);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

/** @param {string} executable */
function assertArm64MachO(executable) {
  const description = describeFile(executable);
  if (!/Mach-O.*arm64/i.test(description) || /x86_64/i.test(description)) {
    throw new Error(
      `Expected arm64-only Mach-O at ${executable}, got: ${description}`,
    );
  }
}

/** @param {string} filePath */
function describeFile(filePath) {
  const result = spawnSync("file", ["-b", filePath], {
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      `file failed for ${filePath}: ${result.stderr || "unknown error"}`,
    );
  }
  return String(result.stdout).trim();
}

/** @param {string} description */
function classifyMachODescription(description) {
  if (!/Mach-O/i.test(description)) {
    return "other";
  }
  const arm64 = /\barm64\b/i.test(description);
  const x86_64 = /\bx86_64\b/i.test(description);
  if (arm64 && x86_64) {
    return "universal-arm64";
  }
  return arm64 ? "arm64" : "unsupported";
}

/** @param {string} currentDir @returns {Promise<number>} */
async function thinUniversalMachOFiles(currentDir) {
  let thinned = 0;
  for (const entry of await readdir(currentDir, { withFileTypes: true })) {
    const entryPath = path.join(currentDir, entry.name);
    const metadata = await lstat(entryPath);
    if (metadata.isSymbolicLink()) {
      continue;
    }
    if (metadata.isDirectory()) {
      thinned += await thinUniversalMachOFiles(entryPath);
      continue;
    }
    if (
      !metadata.isFile() ||
      ((metadata.mode & 0o111) === 0 &&
        !/\.(?:bundle|dylib|node|so)$/i.test(entry.name))
    ) {
      continue;
    }
    const description = describeFile(entryPath);
    const classification = classifyMachODescription(description);
    if (classification === "other") {
      continue;
    }
    if (classification === "unsupported") {
      throw new Error(
        `Python runtime contains non-arm64 Mach-O: ${entryPath}: ${description}`,
      );
    }
    if (classification !== "universal-arm64") {
      continue;
    }
    const thinPath = `${entryPath}.mgt-arm64-thin`;
    await rm(thinPath, { force: true });
    try {
      run("lipo", ["-thin", "arm64", entryPath, "-output", thinPath]);
      await chmod(thinPath, metadata.mode & 0o777);
      await rename(thinPath, entryPath);
    } finally {
      await rm(thinPath, { force: true });
    }
    assertArm64MachO(entryPath);
    thinned += 1;
  }
  return thinned;
}

/** @param {ArchiveAsset & { id: string }} asset */
async function stageLlamaRuntime(asset) {
  const archivePath = await ensureVerifiedDownload(asset);
  const workDir = path.join(extractionRoot, asset.id);
  await extractTarSafely(archivePath, workDir);
  const serverPath = await findFile(workDir, "llama-server");
  if (!serverPath) {
    throw new Error(`${asset.archive} does not contain llama-server`);
  }
  const runtimeSource = path.dirname(serverPath);
  const runtimeTarget = path.join(stagingTools, asset.id);
  await copyMacRuntimePayload(runtimeSource, runtimeTarget);
  const stagedServer = path.join(runtimeTarget, "llama-server");
  await chmod(stagedServer, 0o755);
  assertArm64MachO(stagedServer);
  const dylib = await findFile(runtimeTarget, "libggml.dylib");
  const anyDylib =
    dylib || (await findFirstWithSuffix(runtimeTarget, ".dylib"));
  if (!anyDylib) {
    throw new Error(`${asset.id} is missing its required Metal dylibs`);
  }
  console.log(`[mac-runtime] staged ${asset.id}`);
}

/**
 * Runtime archives may keep a symlink target outside the subtree selected for
 * staging. Copying that subtree while preserving symlinks can therefore leave
 * a broken link in the app bundle. Archive links have already passed the
 * extraction-root escape checks, so materialize them before electron-builder
 * and codesign see the staged runtime.
 *
 * @param {string} runtimeSource
 * @param {string} runtimeTarget
 */
async function copyMacRuntimePayload(runtimeSource, runtimeTarget) {
  await cp(runtimeSource, runtimeTarget, {
    recursive: true,
    dereference: true,
    preserveTimestamps: true,
  });
  await assertNoSymlinks(runtimeTarget);
}

/** @param {string} currentDir */
async function assertNoSymlinks(currentDir) {
  for (const entry of await readdir(currentDir, { withFileTypes: true })) {
    const entryPath = path.join(currentDir, entry.name);
    const metadata = await lstat(entryPath);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `Staged macOS runtime still contains symlink: ${entryPath}`,
      );
    }
    if (metadata.isDirectory()) {
      await assertNoSymlinks(entryPath);
    }
  }
}

/** @param {string} currentDir @param {string} suffix @returns {Promise<string | null>} */
async function findFirstWithSuffix(currentDir, suffix) {
  for (const entry of await readdir(currentDir, { withFileTypes: true })) {
    const entryPath = path.join(currentDir, entry.name);
    if (
      (entry.isFile() || entry.isSymbolicLink()) &&
      entry.name.endsWith(suffix)
    ) {
      return entryPath;
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const nested = await findFirstWithSuffix(entryPath, suffix);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

async function stagePythonAndPaddle() {
  const asset = MAC_RUNTIME_MANIFEST.python;
  const archivePath = await ensureVerifiedDownload(asset);
  const workDir = path.join(extractionRoot, "python");
  await extractTarSafely(archivePath, workDir);
  const extractedPython = await findFile(workDir, "python3");
  if (
    !extractedPython ||
    path.basename(path.dirname(extractedPython)) !== "bin"
  ) {
    throw new Error(`${asset.archive} does not contain install/bin/python3`);
  }
  const installRoot = path.dirname(path.dirname(extractedPython));
  await chmod(extractedPython, 0o755);
  assertArm64MachO(extractedPython);
  const wheelhouse = path.join(workDir, "wheels-macos14-arm64");
  await mkdir(wheelhouse, { recursive: true });
  run(
    extractedPython,
    [
      "-m",
      "pip",
      "download",
      "--disable-pip-version-check",
      "--no-cache-dir",
      "--only-binary=:all:",
      "--platform",
      "macosx_14_0_arm64",
      "--implementation",
      "cp",
      "--python-version",
      "3.12",
      "--abi",
      "cp312",
      "--dest",
      wheelhouse,
      ...MAC_RUNTIME_MANIFEST.ocrPackages,
    ],
    {
      PYTHONNOUSERSITE: "1",
      PIP_NO_CACHE_DIR: "1",
    },
  );
  run(
    extractedPython,
    [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--no-cache-dir",
      "--no-index",
      "--find-links",
      wheelhouse,
      ...MAC_RUNTIME_MANIFEST.ocrPackages,
    ],
    {
      PYTHONNOUSERSITE: "1",
      PIP_NO_CACHE_DIR: "1",
    },
  );
  const removedWindowsFiles = await removeWindowsRuntimeFiles(installRoot);
  console.log(
    `[mac-runtime] removed ${removedWindowsFiles.length} Windows-only Python launcher/library files`,
  );
  const pythonTarget = path.join(stagingTools, "python");
  await copyMacRuntimePayload(installRoot, pythonTarget);
  const stagedPython = path.join(pythonTarget, "bin", "python3");
  await chmod(stagedPython, 0o755);
  const thinnedMachOFiles = await thinUniversalMachOFiles(pythonTarget);
  console.log(
    `[mac-runtime] thinned ${thinnedMachOFiles} universal Python Mach-O files to arm64`,
  );
  run(
    stagedPython,
    [
      "-c",
      "import importlib.metadata, platform, paddle; assert platform.machine() == 'arm64'; print(paddle.__version__, importlib.metadata.version('paddleocr'), importlib.metadata.version('mlx-vlm'))",
    ],
    { PYTHONNOUSERSITE: "1" },
  );
  console.log(
    `[mac-runtime] staged CPython ${asset.version} with ${MAC_RUNTIME_MANIFEST.ocrPackages.join(", ")}`,
  );
}

/** @param {string} currentDir @returns {Promise<string[]>} */
async function removeWindowsRuntimeFiles(currentDir) {
  const removed = [];
  for (const entry of await readdir(currentDir, { withFileTypes: true })) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      removed.push(...(await removeWindowsRuntimeFiles(entryPath)));
    } else if (entry.isFile() && /\.(?:exe|dll)$/i.test(entry.name)) {
      await rm(entryPath, { force: true });
      removed.push(entryPath);
    }
  }
  return removed;
}

async function stageFfmpeg() {
  const ffmpegPath = require("ffmpeg-static");
  if (typeof ffmpegPath !== "string" || !existsSync(ffmpegPath)) {
    throw new Error("ffmpeg-static did not provide a macOS executable");
  }
  assertArm64MachO(ffmpegPath);
  const targetDir = path.join(stagingTools, "ffmpeg");
  await mkdir(targetDir, { recursive: true });
  await cp(ffmpegPath, path.join(targetDir, "ffmpeg"));
  await chmod(path.join(targetDir, "ffmpeg"), 0o755);
  const packageDir = path.dirname(ffmpegPath);
  for (const fileName of ["LICENSE", "README.md"]) {
    const source = path.join(packageDir, fileName);
    if (existsSync(source)) {
      await cp(source, path.join(targetDir, fileName));
    }
  }
  console.log("[mac-runtime] staged arm64 FFmpeg");
}

/** @param {string} name @param {string[]} candidates @param {boolean} required */
async function stageRunner(name, candidates, required) {
  const source = candidates.find((candidate) => existsSync(candidate));
  if (!source) {
    if (!required) {
      return false;
    }
    throw new Error(
      `Missing Apple Silicon ${name}. Build the Metal runner before preparing the runtime.`,
    );
  }
  assertArm64MachO(source);
  const targetDir = path.join(stagingTools, name);
  await mkdir(targetDir, { recursive: true });
  const target = path.join(targetDir, name);
  await cp(source, target);
  await chmod(target, 0o755);
  console.log(`[mac-runtime] staged ${name}`);
  return true;
}

async function stageInpaintingRunners() {
  const targetTriple = "aarch64-apple-darwin";
  const releaseDir = path.join(targetTriple, "release");
  const koharuName = "mgt-koharu-inpaint-runner";
  await stageRunner(
    koharuName,
    [
      String(process.env.MGT_MAC_KOHARU_RUNNER || ""),
      path.join(root, "tools", koharuName, "target", releaseDir, koharuName),
      path.join(root, "tools", "target", releaseDir, koharuName),
    ].filter(Boolean),
    true,
  );
  const fluxName = "mgt-flux-klein";
  await stageRunner(
    fluxName,
    [
      String(process.env.MGT_MAC_FLUX_RUNNER || ""),
      path.join(
        root,
        "tools",
        "mgt-flux-klein-runner",
        "target",
        releaseDir,
        fluxName,
      ),
      path.join(root, "tools", "target", releaseDir, fluxName),
    ].filter(Boolean),
    true,
  );
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Apple Silicon runtime preparation requires macOS arm64.");
  }
  await rm(stagingRoot, { recursive: true, force: true });
  await rm(extractionRoot, { recursive: true, force: true });
  await mkdir(stagingTools, { recursive: true });
  await mkdir(downloadsRoot, { recursive: true });
  await mkdir(extractionRoot, { recursive: true });

  await stageInpaintingRunners();
  if (process.env.MGT_MAC_CLEAN_CARGO_TARGET === "1") {
    for (const targetDir of [
      path.join(root, "tools", "mgt-koharu-inpaint-runner", "target"),
      path.join(root, "tools", "mgt-flux-klein-runner", "target"),
      path.join(root, "tools", "target"),
    ]) {
      await rm(targetDir, { recursive: true, force: true });
    }
    console.log(
      "[mac-runtime] removed Cargo build caches after staging runners",
    );
  }
  for (const asset of MAC_RUNTIME_MANIFEST.llamaRuntimes) {
    await stageLlamaRuntime(asset);
  }
  await stagePythonAndPaddle();
  await stageFfmpeg();
  await cp(
    path.join(root, "scripts", "mac-runtime-manifest.cjs"),
    path.join(stagingTools, "mac-runtime-manifest.cjs"),
  );
  await assertNoSymlinks(stagingTools);
  await rm(extractionRoot, { recursive: true, force: true });
  console.log(`[mac-runtime] complete: ${stagingRoot}`);
}

module.exports = {
  assertSafeArchiveEntry,
  classifyMachODescription,
  copyMacRuntimePayload,
  extractTarSafely,
  isSameOrDescendant,
  removeWindowsRuntimeFiles,
  sha256File,
  thinUniversalMachOFiles,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
