const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { run } = require("./core.cjs");
const { CODEX_APP_SERVER_VERSION } = require("../codex-app-server-runtime.cjs");

const root = join(__dirname, "..", "..");

/** @param {string} appPath */
function verifyPackagedArchiveRuntimes(appPath) {
  const appExecutable = packagedAppExecutable(appPath);
  const resourcesDir = join(appPath, "Contents", "Resources");
  const tarRuntimePath = join(
    resourcesDir,
    "app-runtime",
    "simple-page-tar-utils.cjs",
  );
  const zipRuntimePath = join(
    resourcesDir,
    "app-runtime",
    "simple-page-zip-utils.cjs",
  );
  const packagedManifestPath = join(resourcesDir, "app.asar", "package.json");
  assertFileExists(tarRuntimePath, "Packaged TAR runtime");
  assertFileExists(zipRuntimePath, "Packaged ZIP runtime");
  run(
    appExecutable,
    [
      join(root, "scripts", "smoke-packaged-archive-runtimes.cjs"),
      tarRuntimePath,
      zipRuntimePath,
      packagedManifestPath,
    ],
    {
      env: { ELECTRON_RUN_AS_NODE: "1" },
      timeout: 60_000,
    },
  );
}

/** @param {string} appPath */
function verifyPackagedImageRuntime(appPath) {
  const appExecutable = packagedAppExecutable(appPath);
  const resourcesDir = join(appPath, "Contents", "Resources");
  const imageRuntimePath = join(
    resourcesDir,
    "app-runtime",
    "simple-page-translate.cjs",
  );
  const ffmpegPath = join(resourcesDir, "tools", "ffmpeg", "ffmpeg");
  assertFileExists(imageRuntimePath, "Packaged image runtime");
  assertFileExists(ffmpegPath, "Packaged FFmpeg runtime");
  run(
    appExecutable,
    [
      join(root, "scripts", "smoke-packaged-image-runtime.cjs"),
      imageRuntimePath,
      ffmpegPath,
    ],
    {
      env: { ELECTRON_RUN_AS_NODE: "1" },
      timeout: 60_000,
    },
  );
}

/** @param {string} appPath */
function verifyPackagedCodexRuntime(appPath) {
  const appExecutable = packagedAppExecutable(appPath);
  const runtimeDir = join(appPath, "Contents", "Resources", "c");
  const codexExecutable = join(runtimeDir, "bin", "codex");
  const manifestPath = join(runtimeDir, "codex-package.json");
  for (const [filePath, label] of [
    [codexExecutable, "Packaged Codex App Server"],
    [
      join(runtimeDir, "bin", "codex-code-mode-host"),
      "Packaged Codex code-mode host",
    ],
    [join(runtimeDir, "codex-path", "rg"), "Packaged Codex rg"],
    [manifestPath, "Packaged Codex manifest"],
  ]) {
    assertFileExists(filePath, label);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest.version !== CODEX_APP_SERVER_VERSION ||
    manifest.target !== "aarch64-apple-darwin" ||
    manifest.entrypoint !== "bin/codex"
  ) {
    throw new Error(
      "Packaged Codex runtime manifest does not match the pinned arm64 target.",
    );
  }
  run(
    appExecutable,
    [
      join(root, "scripts", "smoke-codex-app-server-runtime.cjs"),
      codexExecutable,
    ],
    {
      env: { ELECTRON_RUN_AS_NODE: "1" },
      timeout: 30_000,
    },
  );
}

/** @param {string} appPath */
function packagedAppExecutable(appPath) {
  return join(appPath, "Contents", "MacOS", "CarrotMangaTranslator");
}

/** @param {string} filePath @param {string} label */
function assertFileExists(filePath, label) {
  if (!existsSync(filePath)) {
    throw new Error(`${label} is missing: ${filePath}`);
  }
}

module.exports = {
  verifyPackagedArchiveRuntimes,
  verifyPackagedCodexRuntime,
  verifyPackagedImageRuntime,
};
