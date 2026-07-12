import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..");

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
    expect(config).toContain("!tmp{,/**/*}");
    expect(config).toContain("!fonts{,/**/*}");
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
