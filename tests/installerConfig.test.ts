import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..");

describe("Windows installer clean uninstall option", () => {
  it("includes the custom NSIS script in electron-builder", () => {
    const config = readFileSync(join(repoRoot, "electron-builder.config.cjs"), "utf8");

    expect(config).toContain('include: "build/installer.nsh"');
    expect(config).toContain('from: "tools/ffmpeg"');
    expect(config).toContain('to: "tools/ffmpeg"');
  });

  it("offers an optional clean uninstall section for app data and OCR cache", () => {
    const script = readFileSync(join(repoRoot, "build", "installer.nsh"), "utf8");

    expect(script).toContain("customUnInstallSection");
    expect(script).toContain('Section /o "un.');
    expect(script).toContain('$INSTDIR\\data');
    expect(script).toContain('$LOCALAPPDATA\\manga-gemma-translator');
    expect(script).toContain('$APPDATA\\망가번역기');
  });

  it("stores packaged app data outside the install directory by default", () => {
    const appPaths = readFileSync(join(repoRoot, "src", "main", "appPaths.ts"), "utf8");

    expect(appPaths).toContain('join(localAppData, "manga-gemma-translator")');
    expect(appPaths).toContain("migrateLegacyPackagedData(paths)");
    expect(appPaths).toContain('const legacyDataRoot = join(paths.executableDir, "data")');
    expect(appPaths).not.toContain('const dataRoot = isPackaged ? join(executableDir, "data") : repoRoot');
  });
});
