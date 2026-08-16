import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import {
  evaluateGemmaUnifiedMemory,
  resolveRecommendedGemmaVramModeForUnifiedMemory,
} from "../src/shared/gemmaMemoryPolicy";
import {
  DEFAULT_GEMMA_MODEL_FILE,
  DEFAULT_GEMMA_MODEL_REPO,
  GEMMA_12B_MODEL_FILE_Q4_K_M,
  GEMMA_12B_MODEL_REPO,
  GEMMA_26B_MODEL_FILE_IQ3_S,
  GEMMA_26B_MODEL_REPO,
} from "../src/shared/modelPresets";
import { LlamaRuntimeProfileSchema } from "../src/shared/ipcEnumSchemas";

const require = createRequire(import.meta.url);

const { resolvePreferredLlamaRuntime } =
  require("../src/main/runtime/simple-page-runtime-paths.cjs") as {
    resolvePreferredLlamaRuntime: (options: Record<string, unknown>) => {
      id: string;
      kind: string;
      backend: string;
      dir: string;
      archive: string;
      dflashRing?: string;
      archives: Array<{
        archive: string;
        url: string;
        sha256?: string;
        expectedBytes?: number;
        type?: string;
        stripComponents?: number;
      }>;
    };
  };

const {
  assertMetalDflashConfiguration,
  llamaRuntimeProbeLooksGpuBacked,
  resolveLlamaRuntimePreflightTimeoutMs,
} = require("../src/main/runtime/model/server-preflight.cjs") as {
  assertMetalDflashConfiguration: (
    serverPath: string,
    runtime: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => void;
  llamaRuntimeProbeLooksGpuBacked: (
    output: unknown,
    backend?: unknown,
  ) => boolean;
  resolveLlamaRuntimePreflightTimeoutMs: (
    runtime?: Record<string, unknown>,
  ) => number;
};

const { buildLlamaServerEnv } =
  require("../src/main/runtime/model/server-environment.cjs") as {
    buildLlamaServerEnv: (
      serverPath: string,
      options: Record<string, unknown>,
    ) => NodeJS.ProcessEnv;
  };

const { evaluateGemmaUnifiedMemoryPolicy } =
  require("../src/main/runtime/model/gemma-unified-memory.cjs") as {
    evaluateGemmaUnifiedMemoryPolicy: (
      options: Record<string, unknown>,
      system?: Record<string, unknown>,
    ) => {
      applies: boolean;
      allowed: boolean;
      requiredMemoryMb: number;
      shortageMb: number;
      unsafeOverride: boolean;
    };
  };

const {
  extractSelectedTarEntries,
  validateSelectedTarLinks,
  validateSymlinkTarget,
  validateTarEntries,
} = require("../src/main/runtime/simple-page-tar-utils.cjs") as {
  extractSelectedTarEntries: (
    archivePath: string,
    outputDir: string,
    filter: (name: string, relativePath: string) => boolean,
    options?: {
      stripComponents?: number;
      limits?: {
        maximumEntries?: number;
        maximumEntryBytes?: number;
        maximumExpandedBytes?: number;
        maximumCompressionRatio?: number;
      };
    },
  ) => Promise<void>;
  validateSelectedTarLinks: (
    entries: Array<Record<string, unknown>>,
    stripComponents: number,
    filter: (name: string, relativePath: string) => boolean,
  ) => void;
  validateSymlinkTarget: (outputPath: string, target: string) => void;
  validateTarEntries: (
    entries: Array<Record<string, unknown>>,
    stripComponents?: number,
  ) => void;
};

const {
  assertRuntimeArchiveChecksumsPresent,
  calculateFileSha256,
  verifyRuntimeArchiveChecksums,
} = require("../src/main/runtime/model/llama-runtime-download.cjs") as {
  assertRuntimeArchiveChecksumsPresent: (
    archives: Array<{
      archive: string;
      url: string;
      sha256?: string;
      expectedBytes?: number;
    }>,
  ) => void;
  calculateFileSha256: (filePath: string) => Promise<string>;
  verifyRuntimeArchiveChecksums: (
    paths: string[],
    archives: Array<{
      archive: string;
      url: string;
      sha256?: string;
      expectedBytes?: number;
    }>,
  ) => Promise<
    Array<{
      archivePath: string;
      archive: Record<string, unknown>;
      sha256: string;
      bytes: number;
    }>
  >;
};
const { shouldExtractLlamaRuntimeFile } =
  require("../src/main/runtime/simple-page-llama-runtimes.cjs") as {
    shouldExtractLlamaRuntimeFile: (
      name: string,
      relativePath: string,
    ) => boolean;
  };
const tar = require("tar") as {
  c: (
    options: { cwd: string; file: string; gzip: boolean },
    files: string[],
  ) => Promise<void>;
};

function metalOptions(modelRepo: string, modelFile: string) {
  return {
    llamaRuntimeProfile: "metal",
    modelSource: "huggingface",
    modelRepo,
    modelFile,
  };
}

describe("Apple Silicon Gemma Metal runtimes", () => {
  it("canonicalizes Apple profile aliases to Metal", () => {
    expect(LlamaRuntimeProfileSchema.parse("metal")).toBe("metal");
    expect(LlamaRuntimeProfileSchema.parse("apple-metal")).toBe("metal");
    expect(LlamaRuntimeProfileSchema.parse("mps")).toBe("metal");
  });

  it("routes 12B/26B to llama.cpp and 31B to BeeLlama CPU-ring", () => {
    for (const [repo, file] of [
      [GEMMA_12B_MODEL_REPO, GEMMA_12B_MODEL_FILE_Q4_K_M],
      [GEMMA_26B_MODEL_REPO, GEMMA_26B_MODEL_FILE_IQ3_S],
    ]) {
      const runtime = resolvePreferredLlamaRuntime(metalOptions(repo, file));
      expect(runtime.id).toBe("llama-b9547-metal-arm64");
      expect(runtime.backend).toBe("metal");
      expect(runtime.archive).toBe("llama-b9547-bin-macos-arm64.tar.gz");
      expect(runtime.archives[0]).toMatchObject({
        sha256:
          "8791fdac4d5b7008b53fd15c609491d5a2fce2d180bb0b0e041eac53c5ade000",
        type: "tar.gz",
        stripComponents: 1,
      });
    }

    const runtime = resolvePreferredLlamaRuntime(
      metalOptions(DEFAULT_GEMMA_MODEL_REPO, DEFAULT_GEMMA_MODEL_FILE),
    );
    expect(runtime).toMatchObject({
      id: "beellama-v0.3.1-metal-arm64",
      kind: "beellama-metal",
      backend: "metal",
      dflashRing: "cpu",
      archive: "beellama-v0.3.1-bin-macos-arm64.tar.gz",
    });
    expect(runtime.archives[0]?.sha256).toBe(
      "14c0af87fc124e50469279ceae96016bbc6f7649de484b1de8a0a38675004556",
    );
  });

  it("requires an Apple Metal device and gives preflight up to 60 seconds", () => {
    expect(
      llamaRuntimeProbeLooksGpuBacked(
        "ggml_metal_init: GPU name: Apple M3 Max; Metal device 0",
        "metal",
      ),
    ).toBe(true);
    expect(
      llamaRuntimeProbeLooksGpuBacked(
        "Available devices:\n  MTL0: Apple M4 Max (53084 MiB, 53083 MiB free)\n  BLAS: Accelerate (0 MiB, 0 MiB free)",
        "metal",
      ),
    ).toBe(true);
    expect(llamaRuntimeProbeLooksGpuBacked("CPU device only", "metal")).toBe(
      false,
    );
    expect(resolveLlamaRuntimePreflightTimeoutMs({ backend: "metal" })).toBe(
      60_000,
    );
  });

  it("pins 31B DFlash to the CPU ring and rejects silent plain-31B fallback", () => {
    const options = {
      ...metalOptions(DEFAULT_GEMMA_MODEL_REPO, DEFAULT_GEMMA_MODEL_FILE),
      useDraft: true,
      workingDir: process.cwd(),
      port: 32123,
    };
    const runtime = resolvePreferredLlamaRuntime(options);
    const serverPath = join(
      process.cwd(),
      "tools",
      runtime.dir,
      "llama-server",
    );
    expect(buildLlamaServerEnv(serverPath, options).GGML_DFLASH_GPU_RING).toBe(
      "0",
    );
    expect(() =>
      assertMetalDflashConfiguration(serverPath, runtime, options),
    ).not.toThrow();
    expect(() =>
      assertMetalDflashConfiguration(serverPath, runtime, {
        ...options,
        useDraft: false,
      }),
    ).toThrow(/DFlash CPU-ring/);
  });
});

describe("Apple unified-memory policy", () => {
  it("selects the 16/24/32GB model tiers", () => {
    expect(resolveRecommendedGemmaVramModeForUnifiedMemory(15 * 1024)).toBe(
      null,
    );
    expect(resolveRecommendedGemmaVramModeForUnifiedMemory(16 * 1024)).toBe(
      "minimum12b",
    );
    expect(resolveRecommendedGemmaVramModeForUnifiedMemory(24 * 1024)).toBe(
      "economy26b",
    );
    expect(resolveRecommendedGemmaVramModeForUnifiedMemory(32 * 1024)).toBe(
      "full31b",
    );
  });

  it("blocks low-memory execution until explicit Alpha confirmation", () => {
    expect(evaluateGemmaUnifiedMemory("economy26b", 20 * 1024)).toMatchObject({
      allowed: false,
      requiresExplicitAlphaConfirmation: true,
      requiredMemoryMb: 24 * 1024,
      shortageMb: 4 * 1024,
    });
    const forced = evaluateGemmaUnifiedMemoryPolicy(
      {
        llamaRuntimeProfile: "metal",
        gemmaVramMode: "full31b",
        allowUnsafeUnifiedMemory: true,
      },
      { platform: "darwin", arch: "arm64", totalMemoryMb: 24 * 1024 },
    );
    expect(forced).toMatchObject({
      applies: true,
      allowed: true,
      shortageMb: 8 * 1024,
      unsafeOverride: true,
    });
  });

  it("uses Metal Gemma defaults and CPU OCR on Apple hardware", () => {
    const appleGpu = (memoryMb: number) => ({
      name: "Apple M3",
      memoryMb,
      unifiedMemoryMb: memoryMb,
      rtxGeneration: null,
      computeCapability: null,
      vendor: "apple" as const,
      supportsRocm: false,
      supportsVulkan: false,
      supportsMetal: true,
    });
    const minimum = resolveDefaultAppSettings({}, appleGpu(16 * 1024));
    expect(minimum.modelProvider).toBe("gemma");
    expect(minimum.gemma.vramMode).toBe("minimum12b");
    expect(minimum.gemma.llamaRuntimeProfile).toBe("metal");
    expect(minimum.ocr.device).toBe("cpu");
    expect(minimum.inpainting?.fluxBackend).toBe("metal-native");
    expect(
      resolveDefaultAppSettings({}, appleGpu(24 * 1024)).gemma.vramMode,
    ).toBe("economy26b");
    expect(
      resolveDefaultAppSettings({}, appleGpu(32 * 1024)).gemma.vramMode,
    ).toBe("full31b");
  });
});

describe("Metal runtime archive integrity", () => {
  it("fails closed when a runtime descriptor omits its digest", () => {
    expect(() =>
      assertRuntimeArchiveChecksumsPresent([
        {
          archive: "runtime.zip",
          url: "https://example.invalid/runtime.zip",
        },
      ]),
    ).toThrow(/SHA-256/);
  });

  it("fails closed when a runtime descriptor omits its exact byte size", () => {
    expect(() =>
      assertRuntimeArchiveChecksumsPresent([
        {
          archive: "runtime.zip",
          url: "https://example.invalid/runtime.zip",
          sha256: "1".repeat(64),
        },
      ]),
    ).toThrow(/expectedBytes/);
  });

  it("rejects path traversal, hard links, and escaping symlinks", () => {
    expect(() =>
      validateTarEntries([{ path: "root/../escape", type: "File" }], 1),
    ).toThrow(/unsafe path/);
    expect(() =>
      validateTarEntries(
        [{ path: "root/libggml.dylib", type: "Link", linkpath: "file" }],
        1,
      ),
    ).toThrow(/unsupported/);
    expect(() =>
      validateSymlinkTarget("libggml.dylib", "../../outside.dylib"),
    ).toThrow(/escapes extraction root/);
    expect(() =>
      validateTarEntries(
        [
          {
            path: "root/libggml.dylib",
            type: "SymbolicLink",
            linkpath: "libggml.0.dylib",
          },
        ],
        1,
      ),
    ).not.toThrow();
  });

  it("resolves multi-hop dylib aliases and rejects incomplete or cyclic chains", () => {
    const regular = {
      path: "root/libggml.0.13.1.dylib",
      type: "File",
    };
    const intermediate = {
      path: "root/libggml.0.dylib",
      type: "SymbolicLink",
      linkpath: "libggml.0.13.1.dylib",
    };
    const alias = {
      path: "root/libggml.dylib",
      type: "SymbolicLink",
      linkpath: "libggml.0.dylib",
    };

    expect(() =>
      validateSelectedTarLinks(
        [alias, intermediate, regular],
        1,
        shouldExtractLlamaRuntimeFile,
      ),
    ).not.toThrow();
    expect(() =>
      validateSelectedTarLinks(
        [alias, intermediate],
        1,
        shouldExtractLlamaRuntimeFile,
      ),
    ).toThrow(/missing or excluded/);
    expect(() =>
      validateSelectedTarLinks(
        [
          alias,
          {
            ...intermediate,
            linkpath: "libggml.dylib",
          },
        ],
        1,
        shouldExtractLlamaRuntimeFile,
      ),
    ).toThrow(/symlink cycle/);
  });

  it("calculates SHA-256 before runtime extraction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mgt-mac-runtime-hash-"));
    try {
      const file = join(dir, "runtime.tar.gz");
      writeFileSync(file, "apple-silicon-runtime");
      expect(await calculateFileSha256(file)).toBe(
        "44c9c555407dde048d213b49a590e553f0d88f1cc9f29b7824b66bcc4aa1f053",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a byte-bound verified receipt for a pinned runtime archive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mgt-runtime-receipt-"));
    try {
      const file = join(dir, "runtime.zip");
      writeFileSync(file, "pinned-runtime");
      const sha256 = await calculateFileSha256(file);
      const archive = {
        archive: "runtime.zip",
        url: "https://example.invalid/runtime.zip",
        sha256,
        expectedBytes: 14,
      };

      const receipts = await verifyRuntimeArchiveChecksums([file], [archive]);
      expect(receipts).toEqual([
        {
          archivePath: file,
          archive,
          sha256,
          bytes: 14,
        },
      ]);
      expect(Object.isFrozen(receipts[0])).toBe(true);
      expect(Object.isFrozen(receipts[0]?.archive)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletes a downloaded runtime when its pinned byte size mismatches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mgt-runtime-bad-size-"));
    try {
      const file = join(dir, "runtime.zip");
      writeFileSync(file, "pinned-runtime");
      const sha256 = await calculateFileSha256(file);
      await expect(
        verifyRuntimeArchiveChecksums(
          [file],
          [
            {
              archive: "runtime.zip",
              url: "https://example.invalid/runtime.zip",
              sha256,
              expectedBytes: 15,
            },
          ],
        ),
      ).rejects.toThrow(/크기/);
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletes a downloaded runtime when its pinned checksum mismatches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mgt-mac-runtime-bad-hash-"));
    try {
      const file = join(dir, "runtime.tar.gz");
      writeFileSync(file, "tampered");
      await expect(
        verifyRuntimeArchiveChecksums(
          [file],
          [
            {
              archive: "runtime.tar.gz",
              url: "https://example.invalid/runtime.tar.gz",
              sha256: "0".repeat(64),
            },
          ],
        ),
      ).rejects.toThrow(/체크섬/);
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips the signed release root and keeps only executable runtime files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mgt-mac-runtime-tar-"));
    try {
      const source = join(dir, "source");
      const release = join(source, "llama-b9547");
      const output = join(dir, "output");
      const archive = join(dir, "runtime.tar.gz");
      mkdirSync(release, { recursive: true });
      writeFileSync(join(release, "llama-server"), "mach-o");
      writeFileSync(join(release, "libggml-metal.dylib"), "metal");
      writeFileSync(join(release, "README.md"), "not part of runtime");
      await tar.c({ cwd: source, file: archive, gzip: true }, ["llama-b9547"]);

      await extractSelectedTarEntries(
        archive,
        output,
        shouldExtractLlamaRuntimeFile,
        { stripComponents: 1 },
      );

      expect(readFileSync(join(output, "llama-server"), "utf8")).toBe("mach-o");
      expect(readFileSync(join(output, "libggml-metal.dylib"), "utf8")).toBe(
        "metal",
      );
      expect(() => readFileSync(join(output, "README.md"))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies caller-provided entry limits during the TAR metadata pass", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mgt-mac-runtime-tar-limit-"));
    try {
      const source = join(dir, "source");
      const release = join(source, "llama-runtime");
      const output = join(dir, "output");
      const archive = join(dir, "runtime.tar.gz");
      mkdirSync(release, { recursive: true });
      writeFileSync(join(release, "llama-server"), "12345");
      writeFileSync(join(release, "after-error.bin"), "ok");
      await tar.c({ cwd: source, file: archive, gzip: true }, [
        "llama-runtime/llama-server",
        "llama-runtime/after-error.bin",
      ]);

      await expect(
        extractSelectedTarEntries(
          archive,
          output,
          shouldExtractLlamaRuntimeFile,
          {
            stripComponents: 1,
            limits: { maximumEntryBytes: 4 },
          },
        ),
      ).rejects.toThrow(/entry is too large/);
      expect(existsSync(output)).toBe(false);

      await extractSelectedTarEntries(
        archive,
        output,
        shouldExtractLlamaRuntimeFile,
        {
          stripComponents: 1,
          limits: { maximumEntryBytes: 5 },
        },
      );
      expect(readFileSync(join(output, "llama-server"), "utf8")).toBe("12345");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects TAR entries that collide after path stripping", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mgt-mac-runtime-duplicate-"));
    try {
      const source = join(dir, "source");
      const output = join(dir, "output");
      const archive = join(dir, "runtime.tar.gz");
      mkdirSync(join(source, "one"), { recursive: true });
      mkdirSync(join(source, "two"), { recursive: true });
      writeFileSync(join(source, "one", "llama-server"), "first");
      writeFileSync(join(source, "two", "llama-server"), "second");
      await tar.c({ cwd: source, file: archive, gzip: true }, [
        "one/llama-server",
        "two/llama-server",
      ]);

      await expect(
        extractSelectedTarEntries(
          archive,
          output,
          shouldExtractLlamaRuntimeFile,
          { stripComponents: 1 },
        ),
      ).rejects.toThrow(/duplicate output/);
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "extracts multi-hop runtime symlinks before their target files",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "mgt-mac-runtime-symlink-"));
      try {
        const source = join(dir, "source");
        const releaseName = "beellama-v0.3.1";
        const release = join(source, releaseName);
        const output = join(dir, "output");
        const archive = join(dir, "runtime.tar.gz");
        mkdirSync(release, { recursive: true });
        writeFileSync(join(release, "libmtmd.0.13.1.dylib"), "metal");
        writeFileSync(join(release, "llama-server"), "mach-o");
        symlinkSync("libmtmd.0.13.1.dylib", join(release, "libmtmd.0.dylib"));
        symlinkSync("libmtmd.0.dylib", join(release, "libmtmd.dylib"));
        await tar.c({ cwd: source, file: archive, gzip: true }, [
          `${releaseName}/libmtmd.dylib`,
          `${releaseName}/libmtmd.0.dylib`,
          `${releaseName}/libmtmd.0.13.1.dylib`,
          `${releaseName}/llama-server`,
        ]);

        await extractSelectedTarEntries(
          archive,
          output,
          shouldExtractLlamaRuntimeFile,
          { stripComponents: 1 },
        );

        expect(readFileSync(join(output, "libmtmd.dylib"), "utf8")).toBe(
          "metal",
        );
        expect(readFileSync(join(output, "libmtmd.0.dylib"), "utf8")).toBe(
          "metal",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
