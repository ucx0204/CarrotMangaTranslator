const { existsSync } = require("node:fs");
const { join } = require("node:path");

const thinInstaller = process.env.MGT_THIN_INSTALLER === "1";
const bundleFluxNvidiaRunners =
  process.env.MGT_BUNDLE_FLUX_NVIDIA_RUNNERS === "1";
const extraResources = [
  {
    from: "out/app-runtime",
    to: "app-runtime",
  },
];

if (!thinInstaller && existsSync(join(__dirname, "tools", "python"))) {
  extraResources.push({
    from: "tools/python",
    to: "tools/python",
  });
}

if (existsSync(join(__dirname, "tools", "ffmpeg", "ffmpeg.exe"))) {
  extraResources.push({
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
  extraResources.push({
    from: "tools/mgt-flux-klein",
    to: "tools/mgt-flux-klein",
  });
} else if (
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
      extraResources.push({
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
  extraResources.push({
    from: "tools/mgt-koharu-inpaint-runner/mgt-koharu-inpaint-runner.exe",
    to: "tools/mgt-koharu-inpaint-runner/mgt-koharu-inpaint-runner.exe",
  });
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
};
