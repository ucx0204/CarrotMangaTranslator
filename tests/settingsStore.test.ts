import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppPaths } from "../src/main/appPaths";
import {
  getAppSettings,
  saveAppSettings,
  type SettingsStoreDiagnostics,
} from "../src/main/settingsStore";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import { CURRENT_GENERATION_LIMITS_VERSION } from "../src/main/settings/appSettingsGenerationLimitMigration";

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

  it("marks newly saved limits so an intentional legacy-sized pair is preserved", async () => {
    const rootDir = await createTempDir();
    const paths = makeAppPaths(rootDir);
    const custom = {
      ...resolveDefaultAppSettings({
        MANGA_TRANSLATOR_MODEL_PROVIDER: "openai-api",
        MANGA_TRANSLATOR_API_MODEL: "gemini-3.5-flash-lite",
      }),
      maxTokens: 12000,
      ctx: 16384,
    };

    await saveAppSettings(custom, paths, {}, async () => null);
    const persisted = JSON.parse(
      await readFile(paths.settingsPath, "utf8"),
    ) as {
      generationLimitsVersion?: number;
    };
    const restored = await getAppSettings(paths, {}, async () => null);

    expect(persisted.generationLimitsVersion).toBe(
      CURRENT_GENERATION_LIMITS_VERSION,
    );
    expect(restored).toMatchObject({ maxTokens: 12000, ctx: 16384 });
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
