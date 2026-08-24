import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppPaths } from "../src/main/appPaths";
import {
  getAppSettings,
  getDefaultAppSettings,
  maskAppSettingsSecrets,
  normalizeAppSettingsForRuntime,
  saveAppSettings,
  type SettingsStoreDiagnostics,
} from "../src/main/settingsStore";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import { CURRENT_GENERATION_LIMITS_VERSION } from "../src/main/settings/appSettingsGenerationLimitMigration";
import { SETTINGS_SECRET_PRESERVE_SENTINEL } from "../src/shared/settingsSecrets";
import { settingsSecretVaultPath } from "../src/main/settingsSecretStore";
import {
  commitSettingsPairFiles,
  settingsCommitPath,
  settingsPairDirectory,
} from "../src/main/settingsPairStorage";

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

  it("exposes CUDA capability at runtime without persisting it", async () => {
    const rootDir = await createTempDir();
    const paths = makeAppPaths(rootDir);
    const defaults = resolveDefaultAppSettings();
    const saved = await saveAppSettings(defaults, paths, {}, async () => ({
      name: "NVIDIA GeForce RTX 2070 SUPER",
      memoryMb: 8192,
      rtxGeneration: 20,
      computeCapability: 7.5,
      vendor: "nvidia",
    }));

    expect(saved.runtimeHardware?.computeCapability).toBe(7.5);
    expect(saved.runtimeHardware?.rtxGeneration).toBe(20);
    expect(saved.runtimeHardware?.gpuMemoryMb).toBe(8192);
    const persisted = JSON.parse(
      await readFile(paths.settingsPath, "utf8"),
    ) as {
      runtimeHardware?: unknown;
    };
    expect(persisted.runtimeHardware).toBeUndefined();
  });

  it("recomputes the settings-dialog restore defaults from the detected VRAM", async () => {
    const lowMemoryDefaults = await getDefaultAppSettings({}, async () => ({
      name: "NVIDIA GeForce RTX 2070 SUPER",
      memoryMb: 8192,
      rtxGeneration: 20,
      computeCapability: 7.5,
      vendor: "nvidia",
    }));
    const largerMemoryDefaults = await getDefaultAppSettings({}, async () => ({
      name: "NVIDIA GeForce RTX 3060",
      memoryMb: 12288,
      rtxGeneration: 30,
      computeCapability: 8.6,
      vendor: "nvidia",
    }));

    expect(lowMemoryDefaults.gemma).toMatchObject({
      fitTargetMb: 512,
      mmprojOffload: false,
    });
    expect(largerMemoryDefaults.gemma).toMatchObject({
      fitTargetMb: 1024,
      mmprojOffload: true,
    });
  });

  it.each([
    {
      gpu: {
        name: "AMD Radeon RX 6700 XT",
        memoryMb: 12288,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd" as const,
        rocmArch: "gfx1031",
        supportsVulkan: true,
        supportsRocm: false,
      },
      expectedOcr: {
        device: "cpu",
        gpuBackend: "cuda",
        qualityMode: "economy",
      },
      expectedSupportsOcrRocm: false,
      expectedSupportsFluxZluda: false,
    },
    {
      gpu: {
        name: "AMD Radeon RX 7900 XTX",
        memoryMb: 24576,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd" as const,
        rocmArch: "gfx1100",
        supportsVulkan: true,
        supportsRocm: true,
      },
      expectedOcr: {
        device: "gpu",
        gpuBackend: "rocm-transformers",
        qualityMode: "full",
      },
      expectedSupportsOcrRocm: true,
      expectedSupportsFluxZluda: true,
    },
  ])(
    "normalizes OCR against authoritative $gpu.name capability without persisting it",
    async ({
      gpu,
      expectedOcr,
      expectedSupportsOcrRocm,
      expectedSupportsFluxZluda,
    }) => {
      const rootDir = await createTempDir();
      const paths = makeAppPaths(rootDir);
      const draft = {
        ...resolveDefaultAppSettings({}, gpu),
        ocr: {
          device: "gpu" as const,
          gpuBackend: "rocm-transformers" as const,
          qualityMode: "full" as const,
          gpuCudaTag: "cu126",
        },
        runtimeHardware: {
          gpuVendor: "amd" as const,
          supportsOcrRocm: true,
        },
      };
      const detectGpu = async () => gpu;

      const effective = await normalizeAppSettingsForRuntime(
        draft,
        {},
        detectGpu,
      );
      const saved = await saveAppSettings(draft, paths, {}, detectGpu);

      expect(effective.ocr).toMatchObject(expectedOcr);
      expect(saved.ocr).toEqual(effective.ocr);
      expect(saved.runtimeHardware?.supportsOcrRocm).toBe(
        expectedSupportsOcrRocm,
      );
      expect(saved.runtimeHardware?.supportsFluxZluda).toBe(
        expectedSupportsFluxZluda,
      );
      const persisted = JSON.parse(
        await readFile(paths.settingsPath, "utf8"),
      ) as { runtimeHardware?: unknown };
      expect(persisted.runtimeHardware).toBeUndefined();
    },
  );

  it("keeps manual OCR routing when hardware detection is unavailable", async () => {
    const rootDir = await createTempDir();
    const paths = makeAppPaths(rootDir);
    const draft = {
      ...resolveDefaultAppSettings(),
      ocr: {
        device: "gpu" as const,
        gpuBackend: "rocm-transformers" as const,
        qualityMode: "full" as const,
        gpuCudaTag: "cu126",
      },
    };

    const saved = await saveAppSettings(draft, paths, {}, async () => null);

    expect(saved.ocr).toMatchObject({
      device: "gpu",
      gpuBackend: "rocm-transformers",
      qualityMode: "full",
    });
    expect(saved.runtimeHardware).toMatchObject({ gpuVendor: "unknown" });
    expect(saved.runtimeHardware?.supportsOcrRocm).toBeUndefined();
  });

  it.each([
    {
      detected: {
        name: "AMD Radeon RX 6700 XT",
        memoryMb: 12288,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd" as const,
        rocmArch: "gfx1031",
        supportsVulkan: true,
        supportsRocm: false,
      },
      expectedOcr: {
        device: "cpu",
        gpuBackend: "cuda",
        qualityMode: "economy",
      },
      expectedSupport: false,
      expectedFluxSupport: false,
      env: { MANGA_TRANSLATOR_LLAMA_RUNTIME_PROFILE: "cuda12" },
    },
    {
      detected: null,
      expectedOcr: {
        device: "gpu",
        gpuBackend: "rocm-transformers",
        qualityMode: "full",
      },
      expectedSupport: undefined,
      expectedFluxSupport: undefined,
      env: { MANGA_TRANSLATOR_LLAMA_RUNTIME_PROFILE: "rocm" },
    },
    {
      detected: null,
      expectedOcr: {
        device: "gpu",
        gpuBackend: "rocm-transformers",
        qualityMode: "full",
      },
      expectedSupport: undefined,
      expectedFluxSupport: undefined,
      env: { MANGA_TRANSLATOR_AMD_ROCM_TARGET: "gfx103X" },
    },
  ])(
    "loads stale OCR settings through the authoritative hardware policy ($expectedSupport)",
    async ({
      detected,
      expectedOcr,
      expectedSupport,
      expectedFluxSupport,
      env,
    }) => {
      const rootDir = await createTempDir();
      const paths = makeAppPaths(rootDir);
      const stale = {
        ...resolveDefaultAppSettings(
          {},
          {
            name: "AMD Radeon RX 6700 XT",
            memoryMb: 12288,
            rtxGeneration: null,
            computeCapability: null,
            vendor: "amd" as const,
            rocmArch: "gfx1031",
            supportsVulkan: true,
            supportsRocm: false,
          },
        ),
        ocr: {
          device: "gpu" as const,
          gpuBackend: "rocm-transformers" as const,
          qualityMode: "full" as const,
          gpuCudaTag: "cu126",
        },
      };
      await writeFile(paths.settingsPath, `${JSON.stringify(stale)}\n`, "utf8");

      const loaded = await getAppSettings(paths, env, async () => detected);

      expect(loaded.ocr).toMatchObject(expectedOcr);
      expect(loaded.runtimeHardware?.supportsOcrRocm).toBe(expectedSupport);
      expect(loaded.runtimeHardware?.supportsFluxZluda).toBe(
        expectedFluxSupport,
      );
    },
  );

  it("preserves the explicit OCR GPU environment escape hatch on unsupported AMD", async () => {
    const rootDir = await createTempDir();
    const paths = makeAppPaths(rootDir);
    const rx6700 = {
      name: "AMD Radeon RX 6700 XT",
      memoryMb: 12288,
      rtxGeneration: null,
      computeCapability: null,
      vendor: "amd" as const,
      rocmArch: "gfx1031",
      supportsVulkan: true,
      supportsRocm: false,
    };
    const draft = {
      ...resolveDefaultAppSettings({}, rx6700),
      ocr: {
        device: "gpu" as const,
        gpuBackend: "rocm-transformers" as const,
        qualityMode: "full" as const,
        gpuCudaTag: "cu126",
      },
    };

    const saved = await saveAppSettings(
      draft,
      paths,
      {
        MANGA_TRANSLATOR_PADDLEOCR_DEVICE: "gpu",
        MANGA_TRANSLATOR_OCR_GPU_BACKEND: "rocm-transformers",
      },
      async () => rx6700,
    );

    expect(saved.ocr).toMatchObject({
      device: "gpu",
      gpuBackend: "rocm-transformers",
      qualityMode: "full",
    });
    expect(saved.runtimeHardware?.supportsOcrRocm).toBe(false);
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
    const publicPayload = JSON.parse(persisted) as {
      secretGeneration?: string;
    };
    const vaultPayload = JSON.parse(vault) as {
      generation?: string;
      version?: number;
    };
    const commit = JSON.parse(
      await readFile(settingsCommitPath(paths), "utf8"),
    ) as { generation?: string };
    expect(persisted).not.toContain("sk-private-value");
    expect(persisted).not.toContain("private-header");
    expect(persisted).toContain("public-value");
    expect(vault).not.toContain("sk-private-value");
    expect(vault).not.toContain("private-header");
    expect(vaultPayload.version).toBe(2);
    expect(publicPayload.secretGeneration).toBe(vaultPayload.generation);
    expect(commit.generation).toBe(vaultPayload.generation);

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

  it("never combines canonical mirrors from different credential generations", async () => {
    const rootDir = await createTempDir();
    const paths = makeAppPaths(rootDir);
    const defaults = resolveDefaultAppSettings({
      MANGA_TRANSLATOR_MODEL_PROVIDER: "openai-api",
    });
    await saveAppSettings(
      {
        ...defaults,
        api: {
          ...defaults.api,
          baseUrl: "https://old.example.test/v1",
          apiKey: "OLD_KEY",
        },
      },
      paths,
      {},
      async () => null,
    );

    const mismatchedPublic = JSON.parse(
      await readFile(paths.settingsPath, "utf8"),
    ) as { api: { baseUrl: string } };
    mismatchedPublic.api.baseUrl = "https://new.example.test/v1";
    await writeFile(
      paths.settingsPath,
      `${JSON.stringify(mismatchedPublic, null, 2)}\n`,
      "utf8",
    );

    const loaded = await getAppSettings(paths, {}, async () => null);
    expect(loaded.api.baseUrl).toBe("https://old.example.test/v1");
    expect(loaded.api.apiKey).toBe("OLD_KEY");
  });

  it("fails closed for legacy vaults that cannot be bound to an endpoint generation", async () => {
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
          baseUrl: "https://legacy.example.test/v1",
        },
      })}\n`,
      "utf8",
    );
    await writeFile(
      settingsSecretVaultPath(paths),
      `${JSON.stringify({
        version: 1,
        apiKey: Buffer.from("encrypted:UNBOUND_LEGACY_KEY").toString("base64"),
      })}\n`,
      "utf8",
    );

    const loaded = await getAppSettings(paths, {}, async () => null);
    expect(loaded.api.baseUrl).toBe("https://legacy.example.test/v1");
    expect(loaded.api.apiKey).toBeUndefined();
    expect(await readFile(paths.settingsPath, "utf8")).not.toContain(
      "UNBOUND_LEGACY_KEY",
    );
    const migratedVault = JSON.parse(
      await readFile(settingsSecretVaultPath(paths), "utf8"),
    ) as { version: number; generation: string; apiKey?: string };
    expect(migratedVault).toMatchObject({ version: 2 });
    expect(migratedVault.apiKey).toBeUndefined();
  });

  it("serializes concurrent saves so the endpoint and key always share one generation", async () => {
    const rootDir = await createTempDir();
    const paths = makeAppPaths(rootDir);
    const defaults = resolveDefaultAppSettings({
      MANGA_TRANSLATOR_MODEL_PROVIDER: "openai-api",
    });
    const pairs = [
      ["https://first.example.test/v1", "FIRST_KEY"],
      ["https://second.example.test/v1", "SECOND_KEY"],
      ["https://third.example.test/v1", "THIRD_KEY"],
    ] as const;

    await Promise.all(
      pairs.map(([baseUrl, apiKey]) =>
        saveAppSettings(
          { ...defaults, api: { ...defaults.api, baseUrl, apiKey } },
          paths,
          {},
          async () => null,
        ),
      ),
    );

    const loaded = await getAppSettings(paths, {}, async () => null);
    expect(pairs).toContainEqual([loaded.api.baseUrl, loaded.api.apiKey]);
    const pointer = JSON.parse(
      await readFile(settingsCommitPath(paths), "utf8"),
    ) as { generation: string; previous?: { generation: string } };
    const pairDirectories = await readdir(join(rootDir, ".settings-pairs"));
    expect(pairDirectories.sort()).toEqual(
      [pointer.generation, pointer.previous?.generation]
        .filter((value): value is string => Boolean(value))
        .sort(),
    );
  });

  it("cleans an unpublished pair when runtime input violates the text contract", async () => {
    const rootDir = await createTempDir();
    const paths = makeAppPaths(rootDir);
    const generation = "12345678-1234-4123-8123-123456789abc";

    await expect(
      Reflect.apply(commitSettingsPairFiles, undefined, [
        paths,
        { generation, rawSettingsText: undefined, vaultText: "{}\n" },
      ]),
    ).rejects.toThrow("Could not durably stage both settings pair files");

    expect(existsSync(settingsCommitPath(paths))).toBe(false);
    expect(existsSync(settingsPairDirectory(paths, generation))).toBe(false);
  });

  it("restores the previous complete pair when the current pair is corrupted", async () => {
    const rootDir = await createTempDir();
    const paths = makeAppPaths(rootDir);
    const defaults = resolveDefaultAppSettings({
      MANGA_TRANSLATOR_MODEL_PROVIDER: "openai-api",
    });
    const makeSettings = (baseUrl: string, apiKey: string) => ({
      ...defaults,
      api: { ...defaults.api, baseUrl, apiKey },
    });
    await saveAppSettings(
      makeSettings("https://old.example.test/v1", "OLD_KEY"),
      paths,
      {},
      async () => null,
    );
    await saveAppSettings(
      makeSettings("https://new.example.test/v1", "NEW_KEY"),
      paths,
      {},
      async () => null,
    );
    const pointer = JSON.parse(
      await readFile(settingsCommitPath(paths), "utf8"),
    ) as { generation: string; previous?: { generation: string } };
    expect(pointer.previous?.generation).toBeTruthy();
    await writeFile(
      join(settingsPairDirectory(paths, pointer.generation), "settings.json"),
      "corrupted",
      "utf8",
    );

    const recovered = await getAppSettings(paths, {}, async () => null);
    expect(recovered.api.baseUrl).toBe("https://old.example.test/v1");
    expect(recovered.api.apiKey).toBe("OLD_KEY");
    const repairedPointer = JSON.parse(
      await readFile(settingsCommitPath(paths), "utf8"),
    ) as { generation: string };
    expect(repairedPointer.generation).toBe(pointer.previous?.generation);
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
