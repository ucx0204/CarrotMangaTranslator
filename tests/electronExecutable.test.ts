import { join } from "node:path";
import { describe, expect, it } from "vitest";

const { resolveElectronExecutable } =
  require("../scripts/electron-executable.cjs") as {
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
});
