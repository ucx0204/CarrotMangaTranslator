const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { run } = require("./core.cjs");

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
  verifyPackagedImageRuntime,
};
