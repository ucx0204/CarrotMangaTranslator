const { createHash } = require("node:crypto");
const { createReadStream, rmSync, writeFileSync } = require("node:fs");
const { basename, join, relative } = require("node:path");
const { verifyMacRuntimeSmokes } = require("../verify-mac-runtime-smokes.cjs");
const { verifyApplicationDirectorySmoke } = require("./app-smoke.cjs");
const {
  assertElectronFrameworkExecutable,
  assertElectronHelperExecutables,
  findAppBundles,
  listFiles,
  resolveMacChecksumFileName,
  run,
} = require("./core.cjs");
const {
  verifyFinalDiskImage,
  verifyFinalZipArchive,
  verifyNativePayload,
  verifyPackagedArchiveRuntimes,
  verifyPackagedBuildChannel,
  verifyPackagedImageRuntime,
  verifyPackagedOnnxRuntime,
  verifyRequiredRuntimes,
  verifySigning,
} = require("./artifacts.cjs");
const root = join(__dirname, "..", "..");
const distDir = join(root, "dist");
const HOSTED_APP_SMOKE_WAIVER_PATH = join(
  distDir,
  "mac-alpha-hosted-app-smoke-waiver.json",
);

/** @param {string} filePath @returns {Promise<string>} */
async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/**
 * @typedef {{
 *   assertFramework: (appPath: string) => void;
 *   assertHelpers: (appPath: string) => void;
 *   verifyNative: (appPath: string) => unknown;
 *   verifyChannel: (appPath: string) => void;
 *   verifySignature: (appPath: string) => void;
 *   verifyOnnx: (appPath: string) => void;
 *   verifyArchives: (appPath: string) => void;
 *   verifyImage: (appPath: string) => void;
 *   verifyApplicationSmoke: (appPath: string) => void;
 *   verifyRuntimes: (appPath: string) => void;
 *   verifyRuntimeSmokes: (options: { appPath: string }) => Promise<void>;
 * }} UnpackedAppVerification
 */

/**
 * @param {string} appPath
 * @param {UnpackedAppVerification} [verification]
 */
async function verifyUnpackedApplication(
  appPath,
  verification = {
    assertFramework: assertElectronFrameworkExecutable,
    assertHelpers: assertElectronHelperExecutables,
    verifyNative: verifyNativePayload,
    verifyChannel: verifyPackagedBuildChannel,
    verifySignature: verifySigning,
    verifyOnnx: verifyPackagedOnnxRuntime,
    verifyArchives: verifyPackagedArchiveRuntimes,
    verifyImage: verifyPackagedImageRuntime,
    verifyApplicationSmoke: verifyApplicationDirectorySmoke,
    verifyRuntimes: verifyRequiredRuntimes,
    verifyRuntimeSmokes: verifyMacRuntimeSmokes,
  },
) {
  verification.assertFramework(appPath);
  verification.assertHelpers(appPath);
  verification.verifyNative(appPath);
  verification.verifyChannel(appPath);
  verification.verifySignature(appPath);
  verification.verifyOnnx(appPath);
  verification.verifyArchives(appPath);
  verification.verifyImage(appPath);
  verification.verifyApplicationSmoke(appPath);
  verification.verifyRuntimes(appPath);
  await verification.verifyRuntimeSmokes({ appPath });
  verification.verifySignature(appPath);
}

/** @param {string[]} files */
function resolveMacArtifactSet(files) {
  const diskImages = files.filter((filePath) => filePath.endsWith(".dmg"));
  const zipArchives = files.filter((filePath) => filePath.endsWith(".zip"));
  if (diskImages.length !== 1 || zipArchives.length !== 1) {
    throw new Error(
      `Expected one arm64 DMG and ZIP, found DMG=${diskImages.length} ZIP=${zipArchives.length}`,
    );
  }
  return { diskImage: diskImages[0], zipArchive: zipArchives[0] };
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("macOS package verification requires macOS arm64.");
  }
  rmSync(HOSTED_APP_SMOKE_WAIVER_PATH, { force: true });
  const apps = findAppBundles(distDir);
  if (apps.length !== 1) {
    throw new Error(`Expected one unpacked .app in dist, found ${apps.length}`);
  }
  const appPath = apps[0];
  await verifyUnpackedApplication(appPath);

  const { diskImage, zipArchive } = resolveMacArtifactSet(listFiles(distDir));
  run("hdiutil", ["verify", diskImage], { timeout: 120_000 });
  if (process.env.MGT_MAC_SIGNING_MODE === "developer-id") {
    run("xcrun", ["stapler", "validate", diskImage]);
  }
  verifyFinalDiskImage(diskImage);
  verifyFinalZipArchive(zipArchive);

  const artifacts = [diskImage, zipArchive];
  const sums = (
    await Promise.all(
      artifacts.map(
        async (filePath) => `${await sha256(filePath)}  ${basename(filePath)}`,
      ),
    )
  ).join("\n");
  const checksumPath = join(distDir, resolveMacChecksumFileName());
  writeFileSync(checksumPath, `${sums}\n`, "utf8");
  console.log(
    `[mac-verify] verified ${relative(root, appPath)} and wrote ${relative(root, checksumPath)}`,
  );
}

module.exports = { main, resolveMacArtifactSet, verifyUnpackedApplication };
