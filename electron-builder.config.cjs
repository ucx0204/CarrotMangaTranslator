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
