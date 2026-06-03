import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

describe("settings store", () => {
  afterEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
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
    const { getAppSettings } = await loadSettingsStore(rootDir);

    const settings = await getAppSettings();

    expect(settings.modelProvider).toBe("openai-codex");
    const files = await readdir(rootDir);
    expect(files.some((name) => /^settings\.json\.corrupt-.*\.bak$/.test(name))).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "manga-settings-store-"));
  tempDirs.push(dir);
  return dir;
}

async function loadSettingsStore(rootDir: string): Promise<typeof import("../src/main/settingsStore")> {
  vi.resetModules();
  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => ({
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
      llamaServerPath: join(rootDir, "tools", "llama", "llama-server.exe")
    })
  }));
  vi.doMock("../src/main/gpuInfo", () => ({
    detectBestGpuInfo: async () => null
  }));
  return import("../src/main/settingsStore");
}
