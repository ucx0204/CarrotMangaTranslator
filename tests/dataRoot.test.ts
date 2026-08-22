import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DATA_ROOT_POINTER_FILE,
  PACKAGED_MAIN_RUNTIME_SMOKE_MARKER,
  resolvePackagedDataRoot,
  resolvePackagedMainRuntimeSmokeMarker,
} from "../src/main/dataRoot";

const tempDirs: string[] = [];
const originalLocalAppData = process.env.LOCALAPPDATA;
const originalAppData = process.env.APPDATA;
const originalDataRoot = process.env.MANGA_TRANSLATOR_DATA_ROOT;

afterEach(() => {
  restoreEnv("LOCALAPPDATA", originalLocalAppData);
  restoreEnv("APPDATA", originalAppData);
  restoreEnv("MANGA_TRANSLATOR_DATA_ROOT", originalDataRoot);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("packaged data root resolution", () => {
  it("uses the installer data-root pointer when present", () => {
    const executableDir = createTempDir("mgt-exe-");
    const chosenDataRoot = createTempDir("mgt-data-");
    writeFileSync(
      join(executableDir, DATA_ROOT_POINTER_FILE),
      `${chosenDataRoot}\r\n`,
      "utf8",
    );

    expect(resolvePackagedDataRoot(executableDir, { platform: "win32" })).toBe(
      resolve(chosenDataRoot),
    );
  });

  it("accepts manually edited data-root pointers without trailing CRLF", () => {
    const executableDir = createTempDir("mgt-exe-");
    const chosenDataRoot = createTempDir("mgt-data-");
    writeFileSync(
      join(executableDir, DATA_ROOT_POINTER_FILE),
      chosenDataRoot,
      "utf8",
    );

    expect(resolvePackagedDataRoot(executableDir, { platform: "win32" })).toBe(
      resolve(chosenDataRoot),
    );
  });

  it("trims LF-only data-root pointers", () => {
    const executableDir = createTempDir("mgt-exe-");
    const chosenDataRoot = createTempDir("mgt-data-");
    writeFileSync(
      join(executableDir, DATA_ROOT_POINTER_FILE),
      `${chosenDataRoot}\n`,
      "utf8",
    );

    expect(resolvePackagedDataRoot(executableDir, { platform: "win32" })).toBe(
      resolve(chosenDataRoot),
    );
  });

  it("defaults new installs to the install directory data folder", () => {
    const executableDir = createTempDir("mgt-exe-");
    process.env.LOCALAPPDATA = createTempDir("mgt-local-");
    process.env.APPDATA = createTempDir("mgt-roaming-");

    expect(resolvePackagedDataRoot(executableDir, { platform: "win32" })).toBe(
      resolve(join(executableDir, "data")),
    );
  });

  it("keeps existing AppData installs when no installer pointer exists", () => {
    const executableDir = createTempDir("mgt-exe-");
    const localAppData = createTempDir("mgt-local-");
    process.env.LOCALAPPDATA = localAppData;
    process.env.APPDATA = createTempDir("mgt-roaming-");
    const existingRoot = join(localAppData, "manga-gemma-translator");
    mkdirSync(join(existingRoot, "library"), { recursive: true });

    expect(resolvePackagedDataRoot(executableDir, { platform: "win32" })).toBe(
      resolve(existingRoot),
    );
  });

  it("stores macOS data under Application Support instead of inside the app", () => {
    const executableDir = join(
      createTempDir("mgt-mac-app-"),
      "Carrot Manga Translator.app",
      "Contents",
      "MacOS",
    );
    const appDataDir = join(
      createTempDir("mgt-mac-home-"),
      "Library",
      "Application Support",
    );
    mkdirSync(executableDir, { recursive: true });
    writeFileSync(
      join(executableDir, DATA_ROOT_POINTER_FILE),
      join(executableDir, "data"),
      "utf8",
    );

    expect(
      resolvePackagedDataRoot(executableDir, {
        platform: "darwin",
        appDataDir,
      }),
    ).toBe(resolve(join(appDataDir, "manga-gemma-translator")));
  });

  it("still honors an explicit macOS data root for managed/test installs", () => {
    const executableDir = createTempDir("mgt-mac-exe-");
    const explicitRoot = createTempDir("mgt-mac-explicit-");
    process.env.MANGA_TRANSLATOR_DATA_ROOT = explicitRoot;

    expect(
      resolvePackagedDataRoot(executableDir, {
        platform: "darwin",
        appDataDir: createTempDir("mgt-mac-appdata-"),
      }),
    ).toBe(resolve(explicitRoot));
  });

  it("accepts an exact smoke marker reached through a filesystem path alias", () => {
    const dataRoot = createTempDir("mgt-smoke-data-");
    const aliasParent = createTempDir("mgt-smoke-alias-");
    const aliasRoot = join(aliasParent, "data-alias");
    symlinkSync(
      dataRoot,
      aliasRoot,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(
      resolvePackagedMainRuntimeSmokeMarker(
        dataRoot,
        join(aliasRoot, PACKAGED_MAIN_RUNTIME_SMOKE_MARKER),
      ),
    ).toBe(
      join(realpathSync.native(dataRoot), PACKAGED_MAIN_RUNTIME_SMOKE_MARKER),
    );
  });

  it("rejects a smoke marker outside the canonical data root", () => {
    const dataRoot = createTempDir("mgt-smoke-data-");
    const otherRoot = createTempDir("mgt-smoke-other-");

    expect(() =>
      resolvePackagedMainRuntimeSmokeMarker(
        dataRoot,
        join(otherRoot, PACKAGED_MAIN_RUNTIME_SMOKE_MARKER),
      ),
    ).toThrow("Packaged main runtime smoke marker must be");
  });

  it("rejects a missing or renamed smoke marker", () => {
    const dataRoot = createTempDir("mgt-smoke-data-");

    expect(() =>
      resolvePackagedMainRuntimeSmokeMarker(dataRoot, undefined),
    ).toThrow("Packaged main runtime smoke marker is missing");
    expect(() =>
      resolvePackagedMainRuntimeSmokeMarker(
        dataRoot,
        join(dataRoot, "unexpected.json"),
      ),
    ).toThrow("Packaged main runtime smoke marker must be");
  });
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
