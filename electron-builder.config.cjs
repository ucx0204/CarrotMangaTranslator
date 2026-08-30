const { existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const asar = require("@electron/asar");
const {
  isForbiddenRepositoryPath,
} = require("./scripts/private-workspace-policy.cjs");
const {
  WINDOWS_EXECUTABLE_BASENAME,
  assertFastZipPayload,
} = require("./scripts/installer-zip-safety.cjs");
const {
  assertCodexRuntimeReady,
  resolveCodexRuntime,
} = require("./scripts/codex-app-server-runtime.cjs");

const thinInstaller = process.env.MGT_THIN_INSTALLER === "1";
const bundleFluxNvidiaRunners =
  process.env.MGT_BUNDLE_FLUX_NVIDIA_RUNNERS === "1";
const isMacBuild =
  process.platform === "darwin" || process.env.MGT_TARGET_PLATFORM === "darwin";
const codexRuntime = resolveCodexRuntime(
  __dirname,
  isMacBuild ? "darwin" : "win32",
  isMacBuild ? "arm64" : "x64",
);
const requestedBuildChannel = String(
  process.env.MANGA_TRANSLATOR_BUILD_CHANNEL ||
    process.env.MGT_RELEASE_CHANNEL ||
    "",
).trim();
const macBuildChannel =
  requestedBuildChannel === "stable" ? "stable" : "mac-alpha";
const macArtifactName =
  macBuildChannel === "stable"
    ? "CarrotMangaTranslator-${version}-macOS-arm64.${ext}"
    : "CarrotMangaTranslator-${version}-macOS-arm64-alpha.${ext}";
// APFS stores Korean filenames in a decomposed Unicode form. Electron 43
// compares launched Helper paths byte-for-byte against paths derived from
// CFBundleName, so a Korean macOS product name makes the comparison fail and
// aborts before app.whenReady(). Keep bundle/helper names ASCII on macOS while
// preserving the user-facing Korean display name below.
const productName = isMacBuild ? "CarrotMangaTranslator" : "당근망가번역기";
const macDeveloperSigning = process.env.MGT_MAC_SIGNING_MODE === "developer-id";
const macRuntimeRoot =
  process.env.MGT_MAC_RUNTIME_ROOT || join(__dirname, ".tmp", "mac-runtime");
const stagedMacTools = join(macRuntimeRoot, "tools");
const onnxRuntimeWebVersion = "1.27.0";
const onnxWasmModuleFile = "ort-wasm-simd-threaded.mjs";
const onnxWasmBinaryFile = "ort-wasm-simd-threaded.wasm";
const extraResources = [
  {
    // Keep the official native package layout intact under a short resource
    // root. Codex discovers its sibling runners and bundled rg relative to
    // bin/codex, while the short path remains safe for the Windows installer.
    from: codexRuntime.sourceDir,
    to: codexRuntime.resourceDirectory,
    filter: ["**/*"],
  },
  {
    from: "out/app-runtime",
    to: "app-runtime",
    // Font matching models and trust files are all external runtime assets.
    // Development staging still contains complete local bundles, but neither
    // the R33 runtime nor the cross-script proxy may enter an installer.
    filter: [
      "**/*",
      "!o{,/**/*}",
      "!font-matching{,/**/*}",
      "!font-matching-crossscript-proxy{,/**/*}",
    ],
  },
  {
    from: `node_modules/onnxruntime-web/dist/${onnxWasmModuleFile}`,
    to: `app-runtime/onnxruntime-web/${onnxRuntimeWebVersion}/${onnxWasmModuleFile}`,
  },
  // The 13 MiB ort-wasm-simd-threaded.wasm binary must be packaged alongside
  // the .mjs glue so font matching pixel inference (resolveFontMatchingOrtWasm
  // Assets) can resolve it from runtimeRoot without depending on a prior
  // bubble-detection download into the persistent data root. Without this,
  // font matching silently no-ops (disabled("artifact_verification_failed"))
  // on a fresh install where bubble detection has not yet downloaded the WASM.
  {
    from: `node_modules/onnxruntime-web/dist/${onnxWasmBinaryFile}`,
    to: `app-runtime/onnxruntime-web/${onnxRuntimeWebVersion}/${onnxWasmBinaryFile}`,
  },
  // The normal app.asar.unpacked/node_modules path exceeds this project's
  // NSIS Fast ZIP safety limit. Stage the native runtime under the short `o`
  // resource root and load it explicitly from runtimeSupport/nativeOnnxRuntime.
  {
    from: "out/app-runtime/o",
    to: "o",
    filter: ["**/*"],
  },
];
const windowsExtraResources = [];
const macExtraResources = [];

if (!thinInstaller && existsSync(join(__dirname, "tools", "python"))) {
  windowsExtraResources.push({
    from: "tools/python",
    to: "tools/python",
    // Exclude regenerable Python bytecode caches. Running tools/python at
    // runtime (OCR/translation) writes __pycache__/*.cpython-3XY.pyc into the
    // source tree; packaging them both bloats the installer and can exceed the
    // NSIS Fast ZIP 79-char path budget (e.g. packaging/__pycache__/…cpython-312
    // .pyc is 85 chars). extraResources does not apply the default __pycache__
    // / .pyc ignores, so they must be excluded explicitly. Python regenerates
    // the caches on first use, matching the pre-existing installed layout.
    // Also exclude the Python packaging toolchain (pip, setuptools, wheel,
    // packaging + dist-info + the setuptools distutils shim). These are package
    // *installers*, not runtime dependencies — OCR/translation uses torch/cv2/
    // numpy, never pip — and their deep site-packages paths (pip/_internal/
    // metadata/importlib/__init__.py is 85 chars) exceed the Fast ZIP 79-char
    // budget. The previously-installed app carried none of these; excluding
    // them reproduces that known-good payload and unblocks the build.
    filter: [
      "**/*",
      "!**/__pycache__/**",
      "!**/*.pyc",
      "!**/*.pyo",
      "!**/site-packages/pip/**",
      "!**/site-packages/pip-*.dist-info/**",
      "!**/site-packages/setuptools/**",
      "!**/site-packages/setuptools-*.dist-info/**",
      "!**/site-packages/pkg_resources/**",
      "!**/site-packages/wheel/**",
      "!**/site-packages/wheel-*.dist-info/**",
      "!**/site-packages/packaging/**",
      "!**/site-packages/packaging-*.dist-info/**",
      "!**/site-packages/_distutils_hack/**",
      "!**/site-packages/distutils-precedence.pth",
      "!**/Scripts/pip*.exe",
      "!**/Scripts/wheel.exe",
    ],
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

const importSourceRunnerPath = join(
  __dirname,
  "tools",
  "mgt-import-source-runner",
  "mgt-import-source-runner.exe",
);
if (existsSync(importSourceRunnerPath)) {
  windowsExtraResources.push({
    from: "tools/mgt-import-source-runner/mgt-import-source-runner.exe",
    to: "tools/mgt-import-source-runner/mgt-import-source-runner.exe",
  });
} else if (!isMacBuild) {
  throw new Error(
    `Missing ${importSourceRunnerPath}. Run npm run build:import-source-runner before packaging.`,
  );
}

if (isMacBuild) {
  macExtraResources.push({
    from: stagedMacTools,
    to: "tools",
  });
}

/**
 * Keep the configuration importable by macOS checks that do not package the
 * app. The runtime must still exist before electron-builder starts a real
 * Apple Silicon package.
 *
 * @param {import("app-builder-lib").PackContext} context
 */
function verifyMacRuntimeReady(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }
  if (!existsSync(stagedMacTools)) {
    throw new Error(
      `Missing staged Apple Silicon runtime: ${stagedMacTools}. Run npm run prepare:mac:runtime first.`,
    );
  }
  assertCodexRuntimeReady(codexRuntime);
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
  const resourcesDir =
    context.electronPlatformName === "darwin"
      ? join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources",
        )
      : join(context.appOutDir, "resources");
  if (context.electronPlatformName === "darwin") {
    const forbidden = listFilesRecursively(resourcesDir).filter((filePath) =>
      /\.(?:exe|dll)$/i.test(filePath),
    );
    if (forbidden.length > 0) {
      throw new Error(
        `Windows binaries leaked into the macOS app: ${forbidden.join(", ")}`,
      );
    }
  }
  const appAsarPath = join(resourcesDir, "app.asar");
  const forbiddenArchiveEntries = asar
    .listPackage(appAsarPath, { isPack: false })
    .map((path) => path.replace(/^[/\\]+/, ""))
    .filter(isForbiddenRepositoryPath);
  if (forbiddenArchiveEntries.length > 0) {
    throw new Error(
      `Private workspace files leaked into app.asar: ${forbiddenArchiveEntries.join(", ")}`,
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
  productName,
  extraMetadata: {
    buildChannel: isMacBuild ? macBuildChannel : "stable",
  },
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
    "!testProject1{,/**/*}",
    // A developer may use the repository root as the app data root while
    // testing. Never package local works, settings generations, or linked
    // workspace metadata from that data root into a release artifact.
    "!results{,/**/*}",
    "!.settings-pairs{,/**/*}",
    "!settings.commit.json",
    "!settings.secrets.json",
    "!block-library.json",
    "!linked-workspaces.json",
    "!linked-sync-queue.json",
    "!codex{,/**/*}",
    "!.codex-workspace{,/**/*}",
    "!ocr-runtime{,/**/*}",
    "!hf-cache{,/**/*}",
    "!llama.cpp{,/**/*}",
    "!fonts{,/**/*}",
    "!dist{,/**/*}",
    "!artifacts{,/**/*}",
    "!datasets{,/**/*}",
    "!coverage{,/**/*}",
    "!tmp{,/**/*}",
    "!.tmp{,/**/*}",
    "!.tmp-*{,/**/*}",
    "!.pytest_cache{,/**/*}",
    "!.ruff_cache{,/**/*}",
    "!.claude{,/**/*}",
    "!.mgt-instance-lock{,/**/*}",
    "!.mgt-instance-candidate-*{,/**/*}",
    "!.mgt-instance-stale-*{,/**/*}",
    "!.mgt-instance-release-*{,/**/*}",
    "!.venv-glmocr{,/**/*}",
    "!logs{,/**/*}",
    "!settings.json",
    "!panel-window-bounds.json",
    "!recent-dialog-paths.json",
    "!docs{,/**/*}",
    "!AGENTS.md",
    "!.dependency-cruiser.cjs",
    "!.prettierignore",
    "!electron-builder.config.cjs",
    "!eslint.config.mjs",
    "!jsconfig.json",
    "!knip.config.cjs",
    "!knip.exports.json",
    "!README.md",
    "!README.*.md",
    "!settings.example.json",
    "!tsconfig*.json",
    "!vite*.config.ts",
    "!vitest.config.ts",
    "!out/app-runtime{,/**/*}",
    // Font pixel inference still uses the ORT-Web Node/WASM entry. Bubble and
    // text segmentation and the cross-script font proxy use the shared native
    // onnxruntime-node loader.
    "!node_modules/onnxruntime-web/docs{,/**/*}",
    "!node_modules/onnxruntime-web/lib{,/**/*}",
    "!node_modules/onnxruntime-web/dist/!(ort.node.min.js)",
    // Node's module compile cache may be written inside a dependency while
    // the development app is running. It is machine-local transient state,
    // and electron-builder can otherwise auto-unpack the binary cache blobs.
    "!node_modules/**/.v8-cache{,/**/*}",
    // These are browser-only dependencies of onnxruntime-web. The Node entry
    // requires only onnxruntime-common and Node built-ins.
    "!node_modules/{flatbuffers,guid-typescript,long,platform,protobufjs}{,/**/*}",
    "!node_modules/@protobufjs{,/**/*}",
    "!node_modules/@types/node{,/**/*}",
    "!node_modules/undici-types{,/**/*}",
    // A platform-specific copy is staged under the short `resources/o` path.
    "!node_modules/onnxruntime-node{,/**/*}",
    // The selected official native distribution is staged under resources/c.
    // Do not also retain the JS launcher or any optional platform packages in ASAR.
    "!node_modules/@openai/codex{,/**/*}",
    "!node_modules/@openai/codex-*{,/**/*}",
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
    extendInfo: {
      CFBundleDisplayName: "당근망가번역기",
    },
    artifactName: macArtifactName,
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
    // The bundled OCR/Metal runtimes make the app roughly 2 GB. dmgbuild's
    // automatic HFS+ sizing can silently omit the 191 MB Electron Framework
    // executable when the calculated image is too tight, so reserve explicit
    // headroom before the image is shrunk and compressed.
    size: "3g",
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
  beforePack: verifyMacRuntimeReady,
  afterPack: verifyPlatformPayload,
};
