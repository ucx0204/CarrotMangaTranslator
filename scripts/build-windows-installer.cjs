const {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, join } = require("node:path");

const FAST_ZIP_COMPRESSION_LEVEL = "1";

/**
 * Replace one exact template fragment and fail loudly when electron-builder
 * changes its vendored NSIS template.
 *
 * @param {string} source
 * @param {string} expected
 * @param {string} replacement
 * @param {string} label
 */
function replaceExactlyOnce(source, expected, replacement, label) {
  const firstIndex = source.indexOf(expected);
  const lastIndex = source.lastIndexOf(expected);
  if (firstIndex < 0 || firstIndex !== lastIndex) {
    throw new Error(
      `Expected exactly one ${label} fragment in electron-builder's NSIS template.`,
    );
  }
  return `${source.slice(0, firstIndex)}${replacement}${source.slice(
    firstIndex + expected.length,
  )}`;
}

/**
 * @param {string} templatesDir
 */
function patchNsisTemplates(templatesDir) {
  const installSectionPath = join(templatesDir, "installSection.nsh");
  const extractPackagePath = join(
    templatesDir,
    "include",
    "extractAppPackage.nsh",
  );
  const installerFunctionsPath = join(templatesDir, "include", "installer.nsh");

  let installSection = readFileSync(installSectionPath, "utf8").replace(
    /\r\n/g,
    "\n",
  );
  installSection = replaceExactlyOnce(
    installSection,
    "${IfNot} ${Silent}\n  SetDetailsPrint none\n${endif}",
    '${IfNot} ${Silent}\n  SetDetailsPrint both\n  DetailPrint "설치 준비 중..."\n${endif}',
    "installer details",
  );
  installSection = replaceExactlyOnce(
    installSection,
    "!insertmacro installApplicationFiles\n!insertmacro registryAddInstallInfo",
    '!insertmacro installApplicationFiles\nDetailPrint "설치 정보를 등록하고 바로가기를 만드는 중..."\n!insertmacro registryAddInstallInfo',
    "post-extraction status",
  );
  writeFileSync(installSectionPath, installSection, "utf8");

  let extractPackage = readFileSync(extractPackagePath, "utf8").replace(
    /\r\n/g,
    "\n",
  );
  extractPackage = replaceExactlyOnce(
    extractPackage,
    '    nsisunz::Unzip "$PLUGINSDIR\\app-$packageArch.zip" "$INSTDIR"',
    '    DetailPrint "프로그램 파일 압축을 해제하는 중..."\n    nsisunz::Unzip "$PLUGINSDIR\\app-$packageArch.zip" "$INSTDIR"',
    "ZIP extraction",
  );
  writeFileSync(extractPackagePath, extractPackage, "utf8");

  let installerFunctions = readFileSync(installerFunctionsPath, "utf8").replace(
    /\r\n/g,
    "\n",
  );
  installerFunctions = replaceExactlyOnce(
    installerFunctions,
    '      !insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"',
    "      ; Manual GitHub-release updates do not use electron-updater's cached installer.",
    "installer cache copy",
  );
  writeFileSync(installerFunctionsPath, installerFunctions, "utf8");
}

/**
 * app-builder-lib exports this runtime setting as writable JavaScript state,
 * although its generated TypeScript declaration marks the binding readonly.
 *
 * @param {typeof import("app-builder-lib/out/targets/nsis/nsisUtil")} nsisUtil
 * @param {string} templatesDir
 */
function setNsisTemplatesDir(nsisUtil, templatesDir) {
  if (!Reflect.set(nsisUtil, "nsisTemplatesDir", templatesDir)) {
    throw new Error(`Unable to set temporary NSIS templates: ${templatesDir}`);
  }
}

/**
 * Node 24's fs.cpSync can terminate the process on some Windows paths. The
 * NSIS template tree contains only regular files and directories, so keep this
 * small deterministic copier instead.
 *
 * @param {string} sourceDir
 * @param {string} targetDir
 */
function copyTemplateDirectory(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyTemplateDirectory(sourcePath, targetPath);
    } else if (entry.isFile()) {
      copyFileSync(sourcePath, targetPath);
    } else {
      throw new Error(`Unsupported NSIS template entry: ${sourcePath}`);
    }
  }
}

async function buildWindowsInstaller() {
  const nsisUtil = require("app-builder-lib/out/targets/nsis/nsisUtil");
  const originalTemplatesDir = nsisUtil.nsisTemplatesDir;
  const temporaryRoot = mkdtempSync(
    join(tmpdir(), "carrot-manga-translator-nsis-"),
  );
  const temporaryTemplatesDir = join(
    temporaryRoot,
    basename(originalTemplatesDir),
  );
  const previousCompressionLevel =
    process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL;
  let templatesDirChanged = false;

  try {
    copyTemplateDirectory(originalTemplatesDir, temporaryTemplatesDir);
    patchNsisTemplates(temporaryTemplatesDir);
    setNsisTemplatesDir(nsisUtil, temporaryTemplatesDir);
    templatesDirChanged = true;
    process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL =
      process.env.MGT_INSTALLER_COMPRESSION_LEVEL || FAST_ZIP_COMPRESSION_LEVEL;

    const { Arch, Platform, build } = require("electron-builder");
    await build({
      targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64),
      config: "electron-builder.config.cjs",
      publish: "never",
    });
  } finally {
    try {
      if (templatesDirChanged) {
        setNsisTemplatesDir(nsisUtil, originalTemplatesDir);
      }
    } finally {
      if (previousCompressionLevel === undefined) {
        delete process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL;
      } else {
        process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL =
          previousCompressionLevel;
      }
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

module.exports = {
  FAST_ZIP_COMPRESSION_LEVEL,
  copyTemplateDirectory,
  patchNsisTemplates,
  replaceExactlyOnce,
  setNsisTemplatesDir,
};

if (require.main === module) {
  buildWindowsInstaller().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
