import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..");
const require = createRequire(import.meta.url);
const { nsisTemplatesDir } =
  require("app-builder-lib/out/targets/nsis/nsisUtil") as {
    nsisTemplatesDir: string;
  };
const { copyTemplateDirectory, patchNsisTemplates } =
  require("../scripts/build-windows-installer.cjs") as {
    copyTemplateDirectory: (sourceDir: string, targetDir: string) => void;
    patchNsisTemplates: (templatesDir: string) => void;
  };

describe("Windows installer clean uninstall option", () => {
  it("includes the custom NSIS script in electron-builder", () => {
    const config = readFileSync(
      join(repoRoot, "electron-builder.config.cjs"),
      "utf8",
    );

    expect(config).toContain('include: "build/installer.nsh"');
    expect(config).toContain("MGT_THIN_INSTALLER");
    // Update metadata: publish target drives latest.yml/blockmap generation.
    expect(config).toContain('provider: "github"');
    expect(config).toContain('owner: "ucx0204"');
    expect(config).toContain('repo: "CarrotMangaTranslator"');
    expect(config).toContain('from: "tools/ffmpeg"');
    expect(config).toContain('to: "tools/ffmpeg"');
    expect(config).toContain("!dist{,/**/*}");
    expect(config).toContain("!ocr-runtime{,/**/*}");
    expect(config).toContain("!hf-cache{,/**/*}");
    expect(config).toContain("!llama.cpp{,/**/*}");
    expect(config).toContain("!runtime{,/**/*}");
    expect(config).toContain("!tmp{,/**/*}");
    expect(config).toContain("!fonts{,/**/*}");
    expect(config).toContain("!panel-window-bounds.json");
    expect(config).toContain("!docs{,/**/*}");
    expect(config).toContain("differentialPackage: false");
    expect(config).toContain("useZip: true");
    expect(config).toContain(
      'electronLanguages: ["en-US", "en-GB", "ko", "ja", "zh-CN", "zh-TW"]',
    );
    expect(config).not.toContain('asarUnpack: ["node_modules/**/*"]');
  });

  it("does not ship renderer-only or build-only packages twice", () => {
    const packageJson = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const bundledOnlyPackages = [
      "@dnd-kit/core",
      "@dnd-kit/sortable",
      "@dnd-kit/utilities",
      "@radix-ui/react-progress",
      "@tabler/icons-react",
      "@types/yauzl",
      "openai-oauth",
      "react",
      "react-dom",
      "react-i18next",
    ];

    for (const packageName of bundledOnlyPackages) {
      expect(packageJson.dependencies).not.toHaveProperty(packageName);
      expect(packageJson.devDependencies).toHaveProperty(packageName);
    }
    for (const runtimePackage of ["adm-zip", "i18next", "yauzl", "zod"]) {
      expect(packageJson.dependencies).toHaveProperty(runtimePackage);
    }
  });

  it("refuses mismatched release metadata and publishes the authored notes", () => {
    const releaseWorkflow = readFileSync(
      join(repoRoot, ".github", "workflows", "release.yml"),
      "utf8",
    );

    expect(releaseWorkflow).toContain("fetch-depth: 0");
    expect(releaseWorkflow).toContain(
      '$expectedRef = "refs/heads/${{ github.event.repository.default_branch }}"',
    );
    expect(releaseWorkflow).toContain(
      "Release workflow must run from '$expectedRef'",
    );
    expect(releaseWorkflow).toContain('$expectedTag = "v$version"');
    expect(releaseWorkflow).toContain(
      "does not match package version '$version'",
    );
    expect(releaseWorkflow).toContain(
      '$notesPath = "docs/release-notes/$tag.md"',
    );
    expect(releaseWorkflow).toContain("$existingTags = @(git tag --list $tag)");
    expect(releaseWorkflow).toContain("if ($existingTags -contains $tag)");
    expect(releaseWorkflow).toContain("not ${{ github.sha }}");
    expect(releaseWorkflow).toContain("body = $releaseNotes");
    expect(releaseWorkflow).toContain(
      "Expected exactly one Windows installer matching",
    );
  });

  it("shows useful progress details and patches only expected NSIS stages", () => {
    const installerScript = readFileSync(
      join(repoRoot, "build", "installer.nsh"),
      "utf8",
    );
    const buildScript = readFileSync(
      join(repoRoot, "scripts", "build-windows-installer.cjs"),
      "utf8",
    );

    expect(installerScript).toContain("!macro customHeader");
    expect(installerScript).toContain("ShowInstDetails show");
    expect(installerScript).toContain("!ifndef BUILD_UNINSTALLER");
    expect(installerScript).not.toContain("ShowUninstDetails show");
    expect(installerScript).toContain("!macro customFiles_x64");
    expect(installerScript).toContain(
      'DetailPrint "프로그램 파일 압축 해제를 완료했습니다."',
    );

    expect(buildScript).toContain("SetDetailsPrint both");
    expect(buildScript).toContain("설치 준비 중...");
    expect(buildScript).toContain("프로그램 파일 압축을 해제하는 중...");
    expect(buildScript).toContain(
      "Manual GitHub-release updates do not use electron-updater",
    );
    expect(buildScript).toContain('FAST_ZIP_COMPRESSION_LEVEL = "1"');
  });

  it("smokes the OAuth bundle through the packaged app import guard", () => {
    const verifier = readFileSync(
      join(repoRoot, "scripts", "verify-packaged-runtime.cjs"),
      "utf8",
    );
    const smokeScript = readFileSync(
      join(repoRoot, "scripts", "smoke-openai-oauth-runtime.cjs"),
      "utf8",
    );

    expect(verifier).toContain('"app.asar"');
    expect(verifier).toContain('"nativeDynamicImport.js"');
    expect(verifier).toContain("packagedNativeImportModule");
    expect(smokeScript).toContain("require(nativeImportModulePath)");
    expect(smokeScript).toContain("importNativeEsm(pathToFileURL(runtimePath)");
  });

  it("strictly patches the actual electron-builder NSIS templates", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "mgt-nsis-test-"));
    const temporaryTemplatesDir = join(
      temporaryRoot,
      basename(nsisTemplatesDir),
    );

    try {
      copyTemplateDirectory(nsisTemplatesDir, temporaryTemplatesDir);
      patchNsisTemplates(temporaryTemplatesDir);

      const installSection = readFileSync(
        join(temporaryTemplatesDir, "installSection.nsh"),
        "utf8",
      );
      const extractPackage = readFileSync(
        join(temporaryTemplatesDir, "include", "extractAppPackage.nsh"),
        "utf8",
      );
      const installerFunctions = readFileSync(
        join(temporaryTemplatesDir, "include", "installer.nsh"),
        "utf8",
      );

      expect(installSection).toContain(
        '${IfNot} ${Silent}\n  SetDetailsPrint both\n  DetailPrint "설치 준비 중..."\n${endif}',
      );
      expect(installSection).toContain(
        '!insertmacro installApplicationFiles\nDetailPrint "설치 정보를 등록하고 바로가기를 만드는 중..."\n!insertmacro registryAddInstallInfo',
      );
      expect(installSection).not.toContain(
        "${IfNot} ${Silent}\n  SetDetailsPrint none\n${endif}",
      );
      expect(extractPackage).toContain(
        '    DetailPrint "프로그램 파일 압축을 해제하는 중..."\n    nsisunz::Unzip "$PLUGINSDIR\\app-$packageArch.zip" "$INSTDIR"',
      );
      expect(installerFunctions).toContain(
        "      ; Manual GitHub-release updates do not use electron-updater's cached installer.",
      );
      expect(installerFunctions).not.toContain(
        '      !insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"',
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("fails loudly if an electron-builder NSIS sentinel changes", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mgt-nsis-sentinel-test-"),
    );
    const temporaryTemplatesDir = join(
      temporaryRoot,
      basename(nsisTemplatesDir),
    );

    try {
      copyTemplateDirectory(nsisTemplatesDir, temporaryTemplatesDir);
      const installSectionPath = join(
        temporaryTemplatesDir,
        "installSection.nsh",
      );
      const installSection = readFileSync(installSectionPath, "utf8");
      const changedTemplate = installSection.replace(
        "  SetDetailsPrint none",
        "  SetDetailsPrint textonly",
      );
      expect(changedTemplate).not.toBe(installSection);
      writeFileSync(installSectionPath, changedTemplate, "utf8");

      expect(() => patchNsisTemplates(temporaryTemplatesDir)).toThrow(
        "Expected exactly one installer details fragment",
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("builds one thin Windows installer instead of separate NVIDIA/AMD bundles", () => {
    const packageJson = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
    };
    const releaseWorkflow = readFileSync(
      join(repoRoot, ".github", "workflows", "release.yml"),
      "utf8",
    );

    expect(packageJson.scripts["dist:win"]).toBe(
      "node scripts/dist-win-thin.cjs",
    );
    expect(packageJson.scripts["dist:win:nvidia"]).toBe(
      "node scripts/dist-win-thin.cjs --with-flux-nvidia",
    );
    expect(packageJson.scripts["dist:win:amd"]).toBe(
      "node scripts/dist-win-thin.cjs",
    );
    expect(releaseWorkflow).toContain('MGT_THIN_INSTALLER: "1"');
    expect(releaseWorkflow).not.toContain("Prepare bundled Python runtime");
    expect(releaseWorkflow).not.toContain("Prepare bundled Flux CUDA runtime");
  });

  it("offers an optional clean uninstall section for app data and OCR cache", () => {
    const script = readFileSync(
      join(repoRoot, "build", "installer.nsh"),
      "utf8",
    );

    expect(script).toContain("customPageAfterChangeDir");
    expect(script).toContain("MgtDataRootPageCreate");
    expect(script).toContain("data-root.txt");
    expect(script).toContain(".manga-gemma-translator-data");
    expect(script).toContain("customRemoveFiles");
    expect(script).toContain("customUnInstallSection");
    expect(script).toContain('Section /o "un.');
    expect(script).toContain("$INSTDIR\\data");
    expect(script).toContain("$MgtDataRoot\\ocr-runtime");
    expect(script).toContain("$LOCALAPPDATA\\manga-gemma-translator");
    expect(script).toContain("$APPDATA\\망가번역기");
  });

  it("keeps the user-selected data root instead of recalculating it during install", () => {
    const script = readFileSync(
      join(repoRoot, "build", "installer.nsh"),
      "utf8",
    );

    expect(script).toContain('${If} $MgtDataRoot == ""');
    expect(script).toContain('StrCpy $MgtDataRoot "$INSTDIR\\data"');
    expect(script).toContain('FileWrite $0 "$MgtDataRoot$\\r$\\n"');
    expect(script).toContain("MgtResolveLegacyAppDataDefault");
    expect(script).toContain(
      "기존 데이터가 발견되어 해당 위치를 기본값으로 표시합니다",
    );
    expect(script).toContain(
      'StrCpy $MgtDataRoot "$LOCALAPPDATA\\manga-gemma-translator"',
    );
  });

  it("does not let the default uninstaller recursively remove the data folder", () => {
    const script = readFileSync(
      join(repoRoot, "build", "installer.nsh"),
      "utf8",
    );

    expect(script).toContain(
      "electron-builder's default uninstaller removes $INSTDIR recursively",
    );
    expect(script).toContain('RMDir /r "$INSTDIR\\resources"');
    expect(script).toContain('RMDir "$INSTDIR"');
    expect(script).not.toContain("RMDir /r $INSTDIR");
    expect(script).not.toContain('RMDir /r "$INSTDIR"');
    expect(script).not.toContain('RMDir /r "$INSTDIR\\data"');
  });

  it("guards selected data cleanup with marker and root-directory checks", () => {
    const script = readFileSync(
      join(repoRoot, "build", "installer.nsh"),
      "utf8",
    );

    expect(script).toContain("un.MgtEnsureSafeDataRoot");
    expect(script).toContain('StrCpy $4 "0"');
    expect(script).toContain("Data root marker missing. Skip cleanup");
    expect(script).toContain("Data root looks like a drive root. Skip cleanup");
    expect(script).toContain('${If} $4 == "1"');
    expect(script).toContain(
      'FileOpen $0 "$MgtDataRoot\\.manga-gemma-translator-data.tmp" w',
    );
  });

  it("trims only CR/LF from data-root pointers", () => {
    const script = readFileSync(
      join(repoRoot, "build", "installer.nsh"),
      "utf8",
    );

    expect(script).toContain("MgtTrimDataRootNewlines");
    expect(script).toContain('OrIf} $3 == "$\\n"');
    expect(script).not.toContain("StrCpy $MgtDataRoot $MgtDataRoot -2");
  });

  it("stores packaged app data under the configured data root", () => {
    const appPaths = readFileSync(
      join(repoRoot, "src", "main", "appPaths.ts"),
      "utf8",
    );

    expect(appPaths).toContain("resolvePackagedDataRoot(executableDir)");
    expect(appPaths).toContain(
      'const ocrRuntimeDir = explicitOcrRuntimeDir || join(dataRoot, "ocr-runtime")',
    );
    expect(appPaths).toContain("migrateLegacyPackagedData(paths)");
    expect(appPaths).toContain('join(paths.executableDir, "data")');
    expect(appPaths).toContain("legacyAppDataRoots()");
    expect(appPaths).toContain("copyLegacyUserDataIfMissing");
    expect(appPaths).toContain('join(sourceDir, "settings.json")');
    expect(appPaths).not.toContain('join(sourceDir, "hf-cache")');
    expect(appPaths).not.toContain('join(sourceDir, "ocr-runtime")');
    expect(appPaths).not.toContain(
      'join(process.env.LOCALAPPDATA || dataRoot, "manga-gemma-translator", "ocr-runtime")',
    );
  });

  it("moves packaged Electron storage under the configured data root", () => {
    const bootstrap = readFileSync(
      join(repoRoot, "src", "main", "bootstrap.ts"),
      "utf8",
    );

    expect(bootstrap).toContain("configurePackagedElectronStorage()");
    expect(bootstrap).toContain('join(dataRoot, "electron-user-data")');
    expect(bootstrap).toContain('join(dataRoot, "electron-session")');
    expect(bootstrap).toContain('join(dataRoot, "tmp", "system-temp")');
    expect(bootstrap).toContain('app.getPath("userData")');
    expect(bootstrap).toContain(
      'join(resolveBootstrapUserDataDir(), "logs", "bootstrap.log")',
    );
    expect(bootstrap).not.toContain(
      'join(dirname(process.execPath), "bootstrap.log")',
    );
  });
});
