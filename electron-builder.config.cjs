const { existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const {
  WINDOWS_EXECUTABLE_BASENAME,
  assertFastZipPayload,
} = require("./scripts/installer-zip-safety.cjs");

const thinInstaller = process.env.MGT_THIN_INSTALLER === "1";
const bundleFluxNvidiaRunners =
  process.env.MGT_BUNDLE_FLUX_NVIDIA_RUNNERS === "1";
const isMacBuild =
  process.platform === "darwin" || process.env.MGT_TARGET_PLATFORM === "darwin";
const macDeveloperSigning = process.env.MGT_MAC_SIGNING_MODE === "developer-id";
const macRuntimeRoot =
  process.env.MGT_MAC_RUNTIME_ROOT || join(__dirname, ".tmp", "mac-runtime");
const extraResources = [
  {
    from: "out/app-runtime",
    to: "app-runtime",
  },
];
const windowsExtraResources = [];
const macExtraResources = [];

if (!thinInstaller && existsSync(join(__dirname, "tools", "python"))) {
  windowsExtraResources.push({
    from: "tools/python",
    to: "tools/python",
  });
}

if (existsSync(join(__dirname, "tools", "ffmpeg", "ffmpeg.exe"))) {
  windowsExtraResources.push({
    from: "tools/ffmpeg",
    to: "tools/ffmpeg",
  });
}

const fluxKleinRunnerPath = join(
  __dirname,
  "tools",
  "mgt-flux-klein",
  "mgt-flux-klein.exe",
);
if (existsSync(fluxKleinRunnerPath)) {
  windowsExtraResources.push({
    from: "tools/mgt-flux-klein",
    to: "tools/mgt-flux-klein",
  });
} else if (
  !isMacBuild &&
  !thinInstaller &&
  process.env.MGT_ALLOW_MISSING_FLUX_RUNNER !== "1"
) {
  throw new Error(
    `Missing ${fluxKleinRunnerPath}. Run node scripts/prepare-flux-klein-runner.cjs before packaging.`,
  );
}

if (bundleFluxNvidiaRunners) {
  for (const computeCap of ["75", "80", "86", "89", "90", "120"]) {
    const runnerDir = `mgt-flux-klein-sm${computeCap}`;
    if (existsSync(join(__dirname, "tools", runnerDir, "mgt-flux-klein.exe"))) {
      windowsExtraResources.push({
        from: `tools/${runnerDir}`,
        to: `tools/${runnerDir}`,
      });
    }
  }
}

const koharuRunnerPath = join(
  __dirname,
  "tools",
  "mgt-koharu-inpaint-runner",
  "mgt-koharu-inpaint-runner.exe",
);
if (existsSync(koharuRunnerPath)) {
  windowsExtraResources.push({
    from: "tools/mgt-koharu-inpaint-runner/mgt-koharu-inpaint-runner.exe",
    to: "tools/mgt-koharu-inpaint-runner/mgt-koharu-inpaint-runner.exe",
  });
}

if (isMacBuild) {
  const stagedTools = join(macRuntimeRoot, "tools");
  if (!existsSync(stagedTools)) {
    throw new Error(
      `Missing staged Apple Silicon runtime: ${stagedTools}. Run npm run prepare:mac:runtime first.`,
    );
  }
  macExtraResources.push({
    from: stagedTools,
    to: "tools",
  });
}

/**
 * @param {import("app-builder-lib").AfterPackContext} context
 */
async function verifyFastZipPayload(context) {
  if (context.electronPlatformName !== "win32") {
    return;
  }
  const result = assertFastZipPayload(context.appOutDir);
  console.log(
    `[installer] verified ${result.entries} ASCII payload entries; longest relative path ${result.maxRelativePathLength} chars`,
  );
}

/**
 * Keep accidental Windows payloads out of the Apple Silicon app before code
 * signing. The post-package verifier performs the Mach-O and signature checks.
 *
 * @param {import("app-builder-lib").AfterPackContext} context
 */
async function verifyPlatformPayload(context) {
  await verifyFastZipPayload(context);
  if (context.electronPlatformName !== "darwin") {
    return;
  }
  const resourcesDir = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents",
    "Resources",
  );
  const forbidden = listFilesRecursively(resourcesDir).filter((filePath) =>
    /\.(?:exe|dll)$/i.test(filePath),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Windows binaries leaked into the macOS app: ${forbidden.join(", ")}`,
    );
  }
}

/** @param {string} directory @returns {string[]} */
function listFilesRecursively(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursively(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

module.exports = {
  appId: "com.sam40.mangagemma.translator",
  productName: "당근망가번역기",
  directories: {
    output: "dist",
  },
  // Generates update metadata (latest.yml + .blockmap) alongside the installer
  // and points update checks at the GitHub Releases for this repo. Publishing
  // itself is still driven by the release workflow, not by `electron-builder`.
  publish: [
    {
      provider: "github",
      owner: "ucx0204",
      repo: "CarrotMangaTranslator",
    },
  ],
  files: [
    "**/*",
    "!src{,/**/*}",
    "!tests{,/**/*}",
    "!scripts{,/**/*}",
    "!tools{,/**/*}",
    "!models{,/**/*}",
    "!runtime{,/**/*}",
    "!library{,/**/*}",
    "!ocr-runtime{,/**/*}",
    "!hf-cache{,/**/*}",
    "!llama.cpp{,/**/*}",
    "!fonts{,/**/*}",
    "!dist{,/**/*}",
    "!tmp{,/**/*}",
    "!.tmp{,/**/*}",
    "!.venv-glmocr{,/**/*}",
    "!logs{,/**/*}",
    "!settings.json",
    "!panel-window-bounds.json",
    "!docs{,/**/*}",
    "!AGENTS.md",
    "!.dependency-cruiser.cjs",
    "!.prettierignore",
    "!electron-builder.config.cjs",
    "!eslint.config.mjs",
    "!jsconfig.json",
    "!knip.json",
    "!knip.exports.json",
    "!README.md",
    "!README.*.md",
    "!settings.example.json",
    "!tsconfig*.json",
    "!vite*.config.ts",
    "!vitest.config.ts",
    "!out/app-runtime{,/**/*}",
  ],
  extraResources,
  asar: true,
  win: {
    icon: "icon.ico",
    // nsis.useZip extracts with nsisunz, which does not honor UTF-8 ZIP
    // filenames. Keep the payload executable ASCII-only while preserving the
    // Korean product, installer, shortcut, and Control Panel display names.
    executableName: WINDOWS_EXECUTABLE_BASENAME,
    artifactName: "${productName} Setup ${version}.${ext}",
    // Keep only the Chromium locale packs that the app can select. The app's
    // own translations remain bundled by Vite; the other Electron locale
    // packs only add installer bytes and disk writes.
    electronLanguages: ["en-US", "en-GB", "ko", "ja", "zh-CN", "zh-TW"],
    target: [
      {
        target: "nsis",
        arch: ["x64"],
      },
    ],
    extraResources: windowsExtraResources,
  },
  mac: {
    target: [
      {
        target: "dmg",
        arch: ["arm64"],
      },
      {
        target: "zip",
        arch: ["arm64"],
      },
    ],
    icon: "build/icon.icns",
    category: "public.app-category.graphics-design",
    minimumSystemVersion: "14.0",
    executableName: "CarrotMangaTranslator",
    artifactName: "CarrotMangaTranslator-${version}-macOS-arm64-alpha.${ext}",
    electronLanguages: ["en-US", "en-GB", "ko", "ja", "zh-CN", "zh-TW"],
    identity: macDeveloperSigning ? undefined : "-",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: macDeveloperSigning
      ? "build/entitlements.mac.plist"
      : "build/entitlements.mac.adhoc.plist",
    entitlementsInherit: macDeveloperSigning
      ? "build/entitlements.mac.plist"
      : "build/entitlements.mac.adhoc.plist",
    notarize: macDeveloperSigning,
    extraResources: macExtraResources,
  },
  dmg: {
    sign: macDeveloperSigning,
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
    // This app links users to GitHub Releases instead of applying
    // differential electron-updater packages. ZIP extracts directly into the
    // install directory and avoids the default 7z temp-extract + full-copy
    // cycle for this large Electron bundle.
    differentialPackage: false,
    useZip: true,
    include: "build/installer.nsh",
  },
  afterPack: verifyPlatformPayload,
};
