import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppPaths } from "../src/main/appPaths";
import {
  getAppSettings,
  maskAppSettingsSecrets,
  saveAppSettings,
  type SettingsStoreDiagnostics,
} from "../src/main/settingsStore";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import { CURRENT_GENERATION_LIMITS_VERSION } from "../src/main/settings/appSettingsGenerationLimitMigration";
import { SETTINGS_SECRET_PRESERVE_SENTINEL } from "../src/shared/settingsSecrets";
import { settingsSecretVaultPath } from "../src/main/settingsSecretStore";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) =>
      value.toString("utf8").replace(/^encrypted:/, ""),
  },
}));

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
    await writeFile(
      settingsPath,
      '{"apiKey":"must-not-survive", malformed',
      "utf8",
    );

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
    const backupName = files.find((name) =>
      /^settings\.json\.corrupt-.*\.bak$/.test(name),
    );
    expect(backupName).toBeTruthy();
    if (!backupName) throw new Error("Expected corrupt settings backup");
    expect(await readFile(join(rootDir, backupName), "utf8")).not.toContain(
      "must-not-survive",
    );
    expect(diagnostics.warn).toHaveBeenCalledOnce();
    expect(diagnostics.error).not.toHaveBeenCalled();
  });

  it("migrates API credentials out of plaintext settings and preserves masked saves", async () => {
    const rootDir = await createTempDir();
    const paths = makeAppPaths(rootDir);
    const defaults = resolveDefaultAppSettings({
      MANGA_TRANSLATOR_MODEL_PROVIDER: "openai-api",
    });
    await writeFile(
      paths.settingsPath,
      `${JSON.stringify({
        ...defaults,
        api: {
          ...defaults.api,
          apiKey: "sk-private-value",
          customHeadersJson: JSON.stringify({
            Authorization: "Bearer private-header",
            "X-Trace": "public-value",
          }),
        },
      })}\n`,
      "utf8",
    );

    const loaded = await getAppSettings(paths, {}, async () => null);
    expect(loaded.api.apiKey).toBe("sk-private-value");
    expect(loaded.api.customHeadersJson).toContain("private-header");

    const persisted = await readFile(paths.settingsPath, "utf8");
    const vault = await readFile(settingsSecretVaultPath(paths), "utf8");
    expect(persisted).not.toContain("sk-private-value");
    expect(persisted).not.toContain("private-header");
    expect(persisted).toContain("public-value");
    expect(vault).not.toContain("sk-private-value");
    expect(vault).not.toContain("private-header");

    const masked = maskAppSettingsSecrets(loaded);
    expect(masked.api.apiKey).toBe(SETTINGS_SECRET_PRESERVE_SENTINEL);
    expect(masked.api.customHeadersJson).not.toContain("private-header");
    const saved = await saveAppSettings(masked, paths, {}, async () => null);
    expect(saved.api.apiKey).toBe("sk-private-value");
    expect(saved.api.customHeadersJson).toContain("private-header");

    const caseChanged = await saveAppSettings(
      {
        ...masked,
        api: {
          ...masked.api,
          customHeadersJson: (masked.api.customHeadersJson ?? "").replace(
            "Authorization",
            "authorization",
          ),
        },
      },
      paths,
      {},
      async () => null,
    );
    expect(caseChanged.api.customHeadersJson).toContain("private-header");
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
