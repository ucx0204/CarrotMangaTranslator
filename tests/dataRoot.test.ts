import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DATA_ROOT_POINTER_FILE,
  resolvePackagedDataRoot,
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

    expect(resolvePackagedDataRoot(executableDir)).toBe(
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

    expect(resolvePackagedDataRoot(executableDir)).toBe(
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

    expect(resolvePackagedDataRoot(executableDir)).toBe(
      resolve(chosenDataRoot),
    );
  });

  it("defaults new installs to the install directory data folder", () => {
    const executableDir = createTempDir("mgt-exe-");
    process.env.LOCALAPPDATA = createTempDir("mgt-local-");
    process.env.APPDATA = createTempDir("mgt-roaming-");

    expect(resolvePackagedDataRoot(executableDir)).toBe(
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

    expect(resolvePackagedDataRoot(executableDir)).toBe(resolve(existingRoot));
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
