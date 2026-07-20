import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const { ensureElectronExecutable, resolveElectronExecutable } =
  require("../scripts/electron-executable.cjs") as {
    ensureElectronExecutable: (
      root: string,
      platform: NodeJS.Platform,
    ) => string;
    resolveElectronExecutable: (
      root: string,
      platform: NodeJS.Platform,
    ) => string;
  };

describe("Electron executable resolution", () => {
  it("uses the Electron app bundle executable on macOS", () => {
    expect(resolveElectronExecutable("/repo", "darwin")).toBe(
      join(
        "/repo",
        "node_modules",
        "electron",
        "dist",
        "Electron.app",
        "Contents",
        "MacOS",
        "Electron",
      ),
    );
  });

  it("keeps the Windows and Linux executable layouts", () => {
    expect(resolveElectronExecutable("C:/repo", "win32")).toBe(
      join("C:/repo", "node_modules", "electron", "dist", "electron.exe"),
    );
    expect(resolveElectronExecutable("/repo", "linux")).toBe(
      join("/repo", "node_modules", "electron", "dist", "electron"),
    );
  });

  it("downloads the Electron binary before a direct first launch", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "mgt-electron-bootstrap-"),
    );
    try {
      const installerPath = join(
        temporaryRoot,
        "node_modules",
        "electron",
        "install.js",
      );
      const executablePath = resolveElectronExecutable(
        temporaryRoot,
        process.platform,
      );
      mkdirSync(dirname(installerPath), { recursive: true });
      writeFileSync(
        installerPath,
        `require("node:fs").mkdirSync(${JSON.stringify(dirname(executablePath))}, { recursive: true });\nrequire("node:fs").writeFileSync(${JSON.stringify(executablePath)}, "electron");\n`,
        "utf8",
      );

      expect(ensureElectronExecutable(temporaryRoot, process.platform)).toBe(
        executablePath,
      );
      expect(existsSync(executablePath)).toBe(true);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
