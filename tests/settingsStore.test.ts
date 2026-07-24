import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppPaths } from "../src/main/appPaths";
import {
  getAppSettings,
  type SettingsStoreDiagnostics,
} from "../src/main/settingsStore";

const tempDirs: string[] = [];

describe("settings store", () => {
  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("backs up malformed settings and returns defaults", async () => {
    const rootDir = await createTempDir();
    const settingsPath = join(rootDir, "settings.json");
    await writeFile(settingsPath, "{ malformed", "utf8");

    const diagnostics: SettingsStoreDiagnostics = {
      error: vi.fn(),
      warn: vi.fn(),
    };
    const settings = await getAppSettings(
      makeAppPaths(rootDir),
      {},
      async () => null,
      diagnostics,
    );

    expect(settings.modelProvider).toBe("openai-codex");
    const files = await readdir(rootDir);
    expect(
      files.some((name) => /^settings\.json\.corrupt-.*\.bak$/.test(name)),
    ).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);
    expect(diagnostics.warn).toHaveBeenCalledOnce();
    expect(diagnostics.error).not.toHaveBeenCalled();
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "manga-settings-store-"));
  tempDirs.push(dir);
  return dir;
}

function makeAppPaths(rootDir: string): AppPaths {
  return {
    isPackaged: false,
    repoRoot: rootDir,
    executableDir: rootDir,
    resourcesDir: rootDir,
    dataRoot: rootDir,
    settingsPath: join(rootDir, "settings.json"),
    libraryDir: join(rootDir, "library"),
    fontsDir: join(rootDir, "fonts"),
    logsDir: join(rootDir, "logs"),
    logFile: join(rootDir, "logs", "app.log"),
    runtimeDir: join(rootDir, "runtime"),
    toolsDir: join(rootDir, "tools"),
    ocrRuntimeDir: join(rootDir, "ocr-runtime"),
    llamaRuntimeDir: join(rootDir, "tools", "llama"),
    llamaServerPath: join(rootDir, "tools", "llama", "llama-server.exe"),
  };
}
