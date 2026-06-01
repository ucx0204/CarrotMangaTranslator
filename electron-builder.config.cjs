const { existsSync } = require("node:fs");
const { join } = require("node:path");

const extraResources = [
  {
    from: "out/app-runtime",
    to: "app-runtime"
  },
  {
    from: "tools/beellama-v0.2.0-cuda12.4",
    to: "tools/beellama-v0.2.0-cuda12.4"
  }
];

if (existsSync(join(__dirname, "tools", "python"))) {
  extraResources.push({
    from: "tools/python",
    to: "tools/python"
  });
}

if (existsSync(join(__dirname, "tools", "ffmpeg", "ffmpeg.exe"))) {
  extraResources.push({
    from: "tools/ffmpeg",
    to: "tools/ffmpeg"
  });
}

const fluxKleinRunnerPath = join(__dirname, "tools", "mgt-flux-klein", "mgt-flux-klein.exe");
if (existsSync(fluxKleinRunnerPath)) {
  extraResources.push({
    from: "tools/mgt-flux-klein",
    to: "tools/mgt-flux-klein"
  });
} else if (process.env.MGT_ALLOW_MISSING_FLUX_RUNNER !== "1") {
  throw new Error(
    `Missing ${fluxKleinRunnerPath}. Run node scripts/prepare-flux-klein-runner.cjs before packaging.`
  );
}

module.exports = {
  appId: "com.sam40.mangagemma.translator",
  productName: "망가번역기",
  directories: {
    output: "dist"
  },
  files: [
    "**/*",
    "!src{,/**/*}",
    "!tests{,/**/*}",
    "!scripts{,/**/*}",
    "!tools{,/**/*}",
    "!models{,/**/*}",
    "!library{,/**/*}",
    "!.tmp{,/**/*}",
    "!.venv-glmocr{,/**/*}",
    "!logs{,/**/*}",
    "!settings.json",
    "!README.md",
    "!out/app-runtime{,/**/*}"
  ],
  asarUnpack: [
    "node_modules/**/*"
  ],
  extraResources,
  asar: true,
  win: {
    target: [
      {
        target: "nsis",
        arch: ["x64"]
      }
    ]
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
    include: "build/installer.nsh"
  }
};
