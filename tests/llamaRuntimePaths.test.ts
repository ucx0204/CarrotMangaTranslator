import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GEMMA_MODEL_FILE,
  DEFAULT_GEMMA_MODEL_REPO,
  GEMMA_26B_MODEL_FILE_IQ3_S,
  GEMMA_26B_MODEL_REPO,
} from "../src/shared/modelPresets";

const require = createRequire(import.meta.url);
const { inferAmdRocmTargetFromText } =
  require("../src/main/runtime/simple-page-amd-rocm-target.cjs") as {
    inferAmdRocmTargetFromText: (value: string) => string | null;
  };
const {
  hasRequiredLlamaRuntimeFiles,
  missingRequiredLlamaRuntimeFiles,
  resolveManagedToolsDir,
  resolveManagedToolsSearchDirs,
  resolvePreferredLlamaRuntime,
} = require("../src/main/runtime/simple-page-runtime-paths.cjs") as {
  hasRequiredLlamaRuntimeFiles: (
    runtimeDir: string,
    runtime: Record<string, unknown>,
  ) => boolean;
  missingRequiredLlamaRuntimeFiles: (
    runtimeDir: string,
    runtime: Record<string, unknown>,
  ) => string[];
  resolveManagedToolsDir: (options?: Record<string, unknown>) => string;
  resolveManagedToolsSearchDirs: (
    options?: Record<string, unknown>,
  ) => string[];
  resolvePreferredLlamaRuntime: (options?: Record<string, unknown>) => {
    id: string;
    kind: string;
    dir: string;
    archive: string;
    url: string;
    backend: string;
    archives: Array<{
      archive: string;
      url: string;
      sha256?: string;
      expectedBytes?: number;
    }>;
    requiredFiles: Array<string | string[]>;
  };
};
const { resolveWindowsLlamaRuntimeMaxRelativePathLength } =
  require("../src/main/runtime/simple-page-llama-runtimes.cjs") as {
    resolveWindowsLlamaRuntimeMaxRelativePathLength: (runtime: {
      id?: string;
      requiredFiles?: Array<string | string[]>;
    }) => number;
  };
const { createCompactRuntimeSiblingDirectory, createRuntimeStagingDirectory } =
  require("../src/main/runtime/runtime-directory-publish.cjs") as {
    createCompactRuntimeSiblingDirectory: (
      outputDir: string,
      kind: "b" | "s" | "z",
    ) => string;
    createRuntimeStagingDirectory: (outputDir: string) => string;
  };
const { resolvePinnedLlamaRuntimeZipExtractionLimits } =
  require("../src/main/runtime/model/llama-runtime-archive-policy.cjs") as {
    resolvePinnedLlamaRuntimeZipExtractionLimits: (
      runtime: Record<string, unknown>,
      archive: Record<string, unknown>,
      verification: { sha256: string; bytes: number },
    ) => { maximumEntryBytes: number } | undefined;
  };
const { resolveRuntimeArchiveMaximumBytes } =
  require("../src/main/runtime/model/llama-runtime-archive-policy.cjs") as {
    resolveRuntimeArchiveMaximumBytes: (archive: {
      expectedBytes?: number;
    }) => number;
  };
const { MAX_REMOTE_RUNTIME_ARCHIVE_BYTES } =
  require("../src/main/runtime/transport/download-budgets.cjs") as {
    MAX_REMOTE_RUNTIME_ARCHIVE_BYTES: number;
  };
const {
  isIncompleteManagedLlamaRuntime,
  resolveLlamaRuntimePreflightTimeoutMs,
} = require("../src/main/runtime/model/server-preflight.cjs") as {
  isIncompleteManagedLlamaRuntime: (
    serverPath: string,
    options?: Record<string, unknown>,
  ) => boolean;
  resolveLlamaRuntimePreflightTimeoutMs: (
    runtime?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => number;
};
const {
  INSTALLED_RUNTIME_HASH_CHUNK_BYTES,
  collectInstalledRuntimeFileHashes,
  hashInstalledRuntimeFile,
} =
  require("../src/main/runtime/model/llama-runtime-installed-integrity.cjs") as {
    INSTALLED_RUNTIME_HASH_CHUNK_BYTES: number;
    collectInstalledRuntimeFileHashes: (
      runtimeDir: string,
    ) => Record<string, string>;
    hashInstalledRuntimeFile: (
      filePath: string,
      io?: {
        closeSync: (fd: number) => void;
        fstatSync: (fd: number) => { isFile: () => boolean; size: number };
        openSync: (filePath: string, flags: string) => number;
        readSync: (
          fd: number,
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null,
        ) => number;
      },
    ) => string;
  };

describe("llama runtime path selection", () => {
  it("keeps pinned Windows runtime path maxima bound to audited archives", () => {
    const cases = [
      [
        "cuda12",
        undefined,
        GEMMA_26B_MODEL_REPO,
        GEMMA_26B_MODEL_FILE_IQ3_S,
        28,
      ],
      [
        "rocm",
        "gfx1201",
        GEMMA_26B_MODEL_REPO,
        GEMMA_26B_MODEL_FILE_IQ3_S,
        127,
      ],
      ["rocm", "gfx90a", GEMMA_26B_MODEL_REPO, GEMMA_26B_MODEL_FILE_IQ3_S, 137],
      [
        "rocm",
        "gfx110X",
        DEFAULT_GEMMA_MODEL_REPO,
        DEFAULT_GEMMA_MODEL_FILE,
        127,
      ],
    ] as const;
    for (const [profile, target, repo, file, maximum] of cases) {
      const runtime = resolvePreferredLlamaRuntime({
        llamaRuntimeProfile: profile,
        llamaRocmTarget: target,
        modelRepo: repo,
        modelFile: file,
      });
      expect(resolveWindowsLlamaRuntimeMaxRelativePathLength(runtime)).toBe(
        maximum,
      );
    }
    expect(
      resolveWindowsLlamaRuntimeMaxRelativePathLength({
        id: "future-unaudited-runtime",
        requiredFiles: ["server.exe"],
      }),
    ).toBe(255);
  });

  it("uses a compact Windows root and transient siblings for pinned HIP paths", () => {
    if (process.platform !== "win32") return;
    const previousLocalAppData = process.env.LOCALAPPDATA;
    const localAppData = "C:\\Users\\mgt\\AppData\\Local";
    process.env.LOCALAPPDATA = localAppData;
    try {
      const workingDir = join("C:\\", "i".repeat(150));
      const options = {
        workingDir,
        llamaRuntimeProfile: "rocm",
        llamaRocmTarget: "gfx110X",
        modelRepo: DEFAULT_GEMMA_MODEL_REPO,
        modelFile: DEFAULT_GEMMA_MODEL_FILE,
      };
      const runtime = resolvePreferredLlamaRuntime(options);
      const longestPinnedEntry =
        "hipblaslt/library/TensileLibrary_B8F8_B8B8F8_HA_Bias_SAB_SCD_SAV_UA_Type_B8B8_HPA_Contraction_l_Ailk_Bjlk_Cijk_Dijk_gfx1200.dat";
      expect(longestPinnedEntry).toHaveLength(127);
      expect(
        resolve(join(workingDir, "tools", runtime.dir, longestPinnedEntry))
          .length,
      ).toBeGreaterThanOrEqual(252);

      const managedToolsDir = resolveManagedToolsDir(options);
      expect(managedToolsDir).toBe(join(localAppData, "MGT", "tools"));
      expect(resolveManagedToolsSearchDirs(options)).toEqual([managedToolsDir]);
      const runtimeDir = join(managedToolsDir, runtime.dir);
      const stagingDir = createRuntimeStagingDirectory(runtimeDir);
      const backupDir = createCompactRuntimeSiblingDirectory(runtimeDir, "b");
      expect(basename(stagingDir)).toMatch(/^\.s-[a-f0-9]{16}$/);
      expect(basename(backupDir)).toMatch(/^\.b-[a-f0-9]{16}$/);
      for (const root of [runtimeDir, stagingDir, backupDir]) {
        expect(resolve(join(root, longestPinnedEntry)).length).toBeLessThan(
          252,
        );
      }
    } finally {
      if (previousLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = previousLocalAppData;
      }
    }
  });

  it("fails closed for explicit or fallback managed-tools roots that remain too long", () => {
    if (process.platform !== "win32") return;
    const previousLocalAppData = process.env.LOCALAPPDATA;
    const longRoot = join("C:\\", "x".repeat(180));
    const baseOptions = {
      workingDir: longRoot,
      llamaRuntimeProfile: "rocm",
      llamaRocmTarget: "gfx110X",
      modelRepo: DEFAULT_GEMMA_MODEL_REPO,
      modelFile: DEFAULT_GEMMA_MODEL_FILE,
    };
    try {
      let explicitError: unknown;
      try {
        resolveManagedToolsDir({
          ...baseOptions,
          managedToolsDir: join(longRoot, "explicit-tools"),
        });
      } catch (error) {
        explicitError = error;
      }
      expect(explicitError).toMatchObject({
        windowsPathCeiling: 252,
        windowsPathUnsafe: true,
        nonRetriable: true,
      });

      process.env.LOCALAPPDATA = longRoot;
      let fallbackError: unknown;
      try {
        resolveManagedToolsDir(baseOptions);
      } catch (error) {
        fallbackError = error;
      }
      expect(fallbackError).toMatchObject({
        fallbackManagedToolsDir: resolve(join(longRoot, "MGT", "tools")),
        windowsPathCeiling: 252,
        windowsPathUnsafe: true,
        nonRetriable: true,
      });
      expect(
        (fallbackError as { fallbackDerivedPathLength?: number })
          .fallbackDerivedPathLength,
      ).toBeGreaterThanOrEqual(252);
    } finally {
      if (previousLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = previousLocalAppData;
      }
    }
  });

  it("budgets the claimed Vulkan archive path before installation", () => {
    if (process.platform !== "win32") return;
    const options = {
      llamaRuntimeProfile: "vulkan",
      modelRepo: GEMMA_26B_MODEL_REPO,
      modelFile: GEMMA_26B_MODEL_FILE_IQ3_S,
    };
    const runtime = resolvePreferredLlamaRuntime(options);
    const archive = runtime.archives[0];
    const claimedName = `.mgt-llama-archive-${"0".repeat(32)}.zip`;
    const baseRoot = join("C:\\", "m");
    const baseClaimPath = resolve(join(baseRoot, ".downloads", claimedName));
    const managedToolsDir = `${baseRoot}${"x".repeat(252 - baseClaimPath.length)}`;
    const claimedPath = resolve(
      join(managedToolsDir, ".downloads", claimedName),
    );
    const integrityPath = resolve(
      join(managedToolsDir, ".downloads", `${archive.archive}.mgt-sha256.json`),
    );
    expect(claimedPath).toHaveLength(252);
    expect(integrityPath.length).toBeLessThan(252);

    expect(() =>
      resolveManagedToolsDir({ ...options, managedToolsDir }),
    ).toThrowError(
      expect.objectContaining({
        derivedPath: claimedPath,
        derivedPathKind: "claimed-runtime-archive",
        derivedPathLength: 252,
        windowsPathUnsafe: true,
        nonRetriable: true,
      }),
    );
  });

  it("infers Azure AMD Radeon PRO V710 style hardware text as gfx110X", () => {
    expect(
      inferAmdRocmTargetFromText("AMD Radeon PRO V710 MxGPU VEN_1002&DEV_7460"),
    ).toBe("gfx110X");
    expect(inferAmdRocmTargetFromText("AMD Radeon PRO V710-8Q")).toBe(
      "gfx110X",
    );
  });

  it("selects the matching Lemonade ROCm runtime for a known AMD target", () => {
    const runtime = resolvePreferredLlamaRuntime({
      llamaRuntimeProfile: "rocm",
      llamaRocmTarget: "gfx1201",
      modelRepo: GEMMA_26B_MODEL_REPO,
      modelFile: GEMMA_26B_MODEL_FILE_IQ3_S,
    });

    expect(runtime.backend).toBe("rocm");
    expect(runtime.id).toBe("lemonade-llama-b1291-rocm-gfx120X");
    expect(runtime.dir).toBe("lemonade-llama-b1291-rocm-gfx120X");
    expect(runtime.archive).toBe("llama-b1291-windows-rocm-gfx120X-x64.zip");
    expect(runtime.url).toContain(
      "lemonade-sdk/llamacpp-rocm/releases/download/b1291/",
    );
    expect(runtime.archives[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("selects BeeLlama HIP Radeon for the 31B ROCm DFlash preset", () => {
    const runtime = resolvePreferredLlamaRuntime({
      llamaRuntimeProfile: "rocm",
      llamaRocmTarget: "gfx110X",
      modelRepo: DEFAULT_GEMMA_MODEL_REPO,
      modelFile: DEFAULT_GEMMA_MODEL_FILE,
    });

    expect(runtime.backend).toBe("rocm");
    expect(runtime.id).toBe("beellama-v0.3.1-hip-radeon");
    expect(runtime.dir).toBe("beellama-v0.3.1-hip-radeon");
    expect(runtime.archive).toBe("beellama-v0.3.1-bin-win-hip-radeon-x64.zip");
    expect(runtime.url).toBe(
      "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.3.1/beellama-v0.3.1-bin-win-hip-radeon-x64.zip",
    );
    expect(runtime.archives[0]).toMatchObject({
      sha256:
        "53302ae602dc43381f1c61794c2508a5e72931916b6de015531683358dc78fbc",
      expectedBytes: 553_375_639,
    });
  });

  it("scopes the large HIP entry budget to the exact verified BeeLlama archive", () => {
    const runtime = resolvePreferredLlamaRuntime({
      llamaRuntimeProfile: "rocm",
      llamaRocmTarget: "gfx110X",
      modelRepo: DEFAULT_GEMMA_MODEL_REPO,
      modelFile: DEFAULT_GEMMA_MODEL_FILE,
    });
    const archive = runtime.archives[0];
    if (!archive?.sha256 || archive.expectedBytes === undefined) {
      throw new Error("BeeLlama HIP archive binding is incomplete.");
    }
    const verification = {
      sha256: archive.sha256,
      bytes: archive.expectedBytes,
    };

    const limits = resolvePinnedLlamaRuntimeZipExtractionLimits(
      runtime,
      archive,
      verification,
    );
    expect(limits).toEqual({ maximumEntryBytes: 1_515_477_504 });
    expect(Object.isFrozen(limits)).toBe(true);
    expect(resolveRuntimeArchiveMaximumBytes(archive)).toBe(553_375_639);

    const mismatches: Array<
      [Record<string, unknown>, Record<string, unknown>, typeof verification]
    > = [
      [{ ...runtime, id: "other-runtime" }, archive, verification],
      [{ ...runtime, kind: "other-kind" }, archive, verification],
      [{ ...runtime, backend: "cuda" }, archive, verification],
      [runtime, { ...archive, archive: "other.zip" }, verification],
      [
        runtime,
        { ...archive, url: "https://example.invalid/other.zip" },
        verification,
      ],
      [runtime, { ...archive, sha256: "0".repeat(64) }, verification],
      [
        runtime,
        { ...archive, expectedBytes: archive.expectedBytes + 1 },
        verification,
      ],
      [runtime, archive, { ...verification, sha256: "0".repeat(64) }],
      [runtime, archive, { ...verification, bytes: verification.bytes + 1 }],
    ];
    for (const [
      candidateRuntime,
      candidateArchive,
      candidateVerification,
    ] of mismatches) {
      expect(
        resolvePinnedLlamaRuntimeZipExtractionLimits(
          candidateRuntime,
          candidateArchive,
          candidateVerification,
        ),
      ).toBeUndefined();
    }

    const otherRuntime = resolvePreferredLlamaRuntime({
      llamaRuntimeProfile: "cuda12",
      modelRepo: GEMMA_26B_MODEL_REPO,
      modelFile: GEMMA_26B_MODEL_FILE_IQ3_S,
    });
    const otherArchive = otherRuntime.archives[0];
    if (!otherArchive?.sha256) {
      throw new Error("CUDA archive binding is incomplete.");
    }
    expect(resolveRuntimeArchiveMaximumBytes(otherArchive)).toBe(
      MAX_REMOTE_RUNTIME_ARCHIVE_BYTES,
    );
    expect(
      resolvePinnedLlamaRuntimeZipExtractionLimits(otherRuntime, otherArchive, {
        sha256: otherArchive.sha256,
        bytes: 0,
      }),
    ).toBeUndefined();

    expect(() =>
      resolveRuntimeArchiveMaximumBytes({ expectedBytes: 0 }),
    ).toThrow(/expectedBytes/);
  });

  it("does not require a target-specific Lemonade archive for 31B ROCm DFlash", () => {
    const runtime = resolvePreferredLlamaRuntime({
      llamaRuntimeProfile: "rocm",
      modelRepo: DEFAULT_GEMMA_MODEL_REPO,
      modelFile: DEFAULT_GEMMA_MODEL_FILE,
      disableHostRocmTargetDetection: true,
    });

    expect(runtime.id).toBe("beellama-v0.3.1-hip-radeon");
    expect(runtime.archive).toBe("beellama-v0.3.1-bin-win-hip-radeon-x64.zip");
  });

  it("accepts BeeLlama HIP Radeon runtime files for DFlash", () => {
    const runtime = resolvePreferredLlamaRuntime({
      llamaRuntimeProfile: "rocm",
      llamaRocmTarget: "gfx110X",
      modelRepo: DEFAULT_GEMMA_MODEL_REPO,
      modelFile: DEFAULT_GEMMA_MODEL_FILE,
    });
    const runtimeDir = mkdtempSync(join(tmpdir(), "mgt-beellama-hip-"));
    try {
      const rocblasDir = join(runtimeDir, "rocblas", "library");
      const hipblasltDir = join(runtimeDir, "hipblaslt", "library");
      mkdirSync(rocblasDir, { recursive: true });
      mkdirSync(hipblasltDir, { recursive: true });
      for (const fileName of [
        "llama-server.exe",
        "llama-server-impl.dll",
        "llama.dll",
        "ggml-hip.dll",
        "rocblas.dll",
        "libhipblas.dll",
        "libhipblaslt.dll",
      ]) {
        writeFileSync(join(runtimeDir, fileName), "");
      }
      writeFileSync(join(rocblasDir, "TensileLibrary_Type_HH_gfx1101.dat"), "");
      writeFileSync(join(hipblasltDir, "Kernels.so-000-gfx1101.hsaco"), "");

      expect(missingRequiredLlamaRuntimeFiles(runtimeDir, runtime)).toEqual([]);
      expect(hasRequiredLlamaRuntimeFiles(runtimeDir, runtime)).toBe(true);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("accepts ROCm 7 HIP runtime DLL names from Lemonade archives", () => {
    const runtime = resolvePreferredLlamaRuntime({
      llamaRuntimeProfile: "rocm",
      llamaRocmTarget: "gfx110X",
      modelRepo: GEMMA_26B_MODEL_REPO,
      modelFile: GEMMA_26B_MODEL_FILE_IQ3_S,
    });
    const runtimeDir = mkdtempSync(join(tmpdir(), "mgt-rocm-runtime-"));
    try {
      const rocblasDir = join(runtimeDir, "rocblas", "library");
      const hipblasltDir = join(runtimeDir, "hipblaslt", "library");
      mkdirSync(rocblasDir, { recursive: true });
      mkdirSync(hipblasltDir, { recursive: true });
      for (const fileName of [
        "llama-server.exe",
        "llama-server-impl.dll",
        "ggml-hip.dll",
        "amdhip64_7.dll",
      ]) {
        writeFileSync(join(runtimeDir, fileName), "");
      }
      writeFileSync(join(rocblasDir, "TensileLibrary_Type_HH_gfx1101.dat"), "");
      writeFileSync(join(hipblasltDir, "Kernels.so-000-gfx1101.hsaco"), "");

      expect(missingRequiredLlamaRuntimeFiles(runtimeDir, runtime)).toEqual([]);
      expect(hasRequiredLlamaRuntimeFiles(runtimeDir, runtime)).toBe(true);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("rejects ROCm runtimes that are missing extracted kernel libraries", () => {
    const runtime = resolvePreferredLlamaRuntime({
      llamaRuntimeProfile: "rocm",
      llamaRocmTarget: "gfx110X",
      modelRepo: GEMMA_26B_MODEL_REPO,
      modelFile: GEMMA_26B_MODEL_FILE_IQ3_S,
    });
    const runtimeDir = mkdtempSync(
      join(tmpdir(), "mgt-rocm-runtime-missing-kernels-"),
    );
    try {
      for (const fileName of [
        "llama-server.exe",
        "llama-server-impl.dll",
        "ggml-hip.dll",
        "amdhip64_7.dll",
      ]) {
        writeFileSync(join(runtimeDir, fileName), "");
      }

      expect(hasRequiredLlamaRuntimeFiles(runtimeDir, runtime)).toBe(false);
      expect(missingRequiredLlamaRuntimeFiles(runtimeDir, runtime)).toEqual(
        expect.arrayContaining([
          "rocblas/library/*.dat|*.co|*.hsaco",
          "hipblaslt/library/*.dat|*.co|*.hsaco",
        ]),
      );
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("rejects a managed runtime whose executable changed after installation", () => {
    const managedToolsDir = mkdtempSync(
      join(tmpdir(), "mgt-managed-runtime-integrity-"),
    );
    const options = {
      managedToolsDir,
      llamaRuntimeProfile: "cuda12",
      modelSource: "huggingface",
      modelRepo: GEMMA_26B_MODEL_REPO,
      modelFile: GEMMA_26B_MODEL_FILE_IQ3_S,
    };
    const runtime = resolvePreferredLlamaRuntime(options);
    const runtimeDir = join(managedToolsDir, runtime.dir);
    mkdirSync(runtimeDir, { recursive: true });
    try {
      for (const requirement of runtime.requiredFiles) {
        const fileName = Array.isArray(requirement)
          ? requirement[0]
          : requirement;
        writeFileSync(join(runtimeDir, fileName), `trusted:${fileName}`);
      }
      const serverName = Array.isArray(runtime.requiredFiles[0])
        ? runtime.requiredFiles[0][0]
        : runtime.requiredFiles[0];
      const serverPath = join(runtimeDir, serverName);
      writeFileSync(
        join(runtimeDir, ".mgt-runtime.json"),
        JSON.stringify({
          id: runtime.id,
          kind: runtime.kind,
          dir: runtime.dir,
          archives: runtime.archives,
          installedFileSha256: collectInstalledRuntimeFileHashes(runtimeDir),
        }),
      );

      expect(isIncompleteManagedLlamaRuntime(serverPath, options)).toBe(false);
      writeFileSync(serverPath, "tampered after installation");
      expect(isIncompleteManagedLlamaRuntime(serverPath, options)).toBe(true);
    } finally {
      rmSync(managedToolsDir, { recursive: true, force: true });
    }
  });

  it("hashes installed runtime files with one bounded reusable chunk", () => {
    const chunkBytes = INSTALLED_RUNTIME_HASH_CHUNK_BYTES;
    const logicalBytes = chunkBytes * 2 + 37;
    const requestedReads: number[] = [];
    const expected = createHash("sha256");
    for (let position = 0; position < logicalBytes; ) {
      const length = Math.min(chunkBytes, logicalBytes - position);
      const byte = Math.floor(position / chunkBytes) + 1;
      expected.update(Buffer.alloc(length, byte));
      position += length;
    }
    let closed = false;
    const digest = hashInstalledRuntimeFile("virtual-large-runtime.dll", {
      openSync(filePath, flags) {
        expect(filePath).toBe("virtual-large-runtime.dll");
        expect(flags).toBe("r");
        return 17;
      },
      fstatSync(fd) {
        expect(fd).toBe(17);
        return { isFile: () => true, size: logicalBytes };
      },
      readSync(fd, buffer, offset, length, position) {
        expect(fd).toBe(17);
        expect(offset).toBe(0);
        expect(position).not.toBeNull();
        requestedReads.push(length);
        const byte = Math.floor(Number(position) / chunkBytes) + 1;
        buffer.fill(byte, 0, length);
        return length;
      },
      closeSync(fd) {
        expect(fd).toBe(17);
        closed = true;
      },
    });

    expect(digest).toBe(expected.digest("hex"));
    expect(requestedReads).toEqual([chunkBytes, chunkBytes, 37]);
    expect(Math.max(...requestedReads)).toBe(chunkBytes);
    expect(closed).toBe(true);
  });

  it("closes and rejects a runtime file that shrinks during chunked hashing", () => {
    let closed = false;
    expect(() =>
      hashInstalledRuntimeFile("shrinking-runtime.dll", {
        openSync: () => 23,
        fstatSync: () => ({ isFile: () => true, size: 8 }),
        readSync: () => 0,
        closeSync: () => {
          closed = true;
        },
      }),
    ).toThrow(/changed while hashing/);
    expect(closed).toBe(true);
  });

  it("hashes required ROCm kernel artifacts and rejects their later tampering", () => {
    const managedToolsDir = mkdtempSync(
      join(tmpdir(), "mgt-managed-rocm-kernel-integrity-"),
    );
    const options = {
      managedToolsDir,
      llamaRuntimeProfile: "rocm",
      llamaRocmTarget: "gfx110X",
      modelSource: "huggingface",
      modelRepo: DEFAULT_GEMMA_MODEL_REPO,
      modelFile: DEFAULT_GEMMA_MODEL_FILE,
    };
    const runtime = resolvePreferredLlamaRuntime(options);
    const runtimeDir = join(managedToolsDir, runtime.dir);
    const rocblasDir = join(runtimeDir, "rocblas", "library");
    const hipblasltDir = join(runtimeDir, "hipblaslt", "library");
    mkdirSync(rocblasDir, { recursive: true });
    mkdirSync(hipblasltDir, { recursive: true });
    try {
      for (const requirement of runtime.requiredFiles) {
        const fileName = Array.isArray(requirement)
          ? requirement[0]
          : requirement;
        writeFileSync(join(runtimeDir, fileName), `trusted:${fileName}`);
      }
      const rocblasKernel = join(
        rocblasDir,
        "TensileLibrary_Type_HH_gfx1101.dat",
      );
      const hipblasltKernel = join(
        hipblasltDir,
        "Kernels.so-000-gfx1101.hsaco",
      );
      const rocblasCodeObject = join(
        rocblasDir,
        "TensileLibrary_Type_HH_gfx1101.co",
      );
      writeFileSync(rocblasKernel, "trusted rocblas kernel");
      writeFileSync(hipblasltKernel, "trusted hipblaslt kernel");
      writeFileSync(rocblasCodeObject, "trusted rocblas code object");
      writeFileSync(join(runtimeDir, "unrelated.dat"), "not executable data");

      const installedFileSha256 = collectInstalledRuntimeFileHashes(runtimeDir);
      expect(installedFileSha256).toHaveProperty(
        "rocblas/library/TensileLibrary_Type_HH_gfx1101.dat",
      );
      expect(installedFileSha256).toHaveProperty(
        "hipblaslt/library/Kernels.so-000-gfx1101.hsaco",
      );
      expect(installedFileSha256).toHaveProperty(
        "rocblas/library/TensileLibrary_Type_HH_gfx1101.co",
      );
      expect(installedFileSha256).not.toHaveProperty("unrelated.dat");

      const serverPath = join(runtimeDir, "llama-server.exe");
      writeFileSync(
        join(runtimeDir, ".mgt-runtime.json"),
        JSON.stringify({
          id: runtime.id,
          kind: runtime.kind,
          dir: runtime.dir,
          // v1.13 markers predate expectedBytes. The immutable SHA binding is
          // sufficient for compatibility while new installs also pin bytes.
          archives: runtime.archives.map((archive) => ({
            archive: archive.archive,
            url: archive.url,
            sha256: archive.sha256,
          })),
          installedFileSha256,
        }),
      );
      expect(isIncompleteManagedLlamaRuntime(serverPath, options)).toBe(false);

      writeFileSync(hipblasltKernel, "tampered hipblaslt kernel");
      expect(isIncompleteManagedLlamaRuntime(serverPath, options)).toBe(true);
    } finally {
      rmSync(managedToolsDir, { recursive: true, force: true });
    }
  });

  it("does not guess an AMD ROCm runtime when the GPU target is unknown", () => {
    expect(() =>
      resolvePreferredLlamaRuntime({
        llamaRuntimeProfile: "rocm",
        modelRepo: GEMMA_26B_MODEL_REPO,
        modelFile: GEMMA_26B_MODEL_FILE_IQ3_S,
        disableHostRocmTargetDetection: true,
      }),
    ).toThrow(/AMD GPU/);
  });

  it("gives ROCm/HIP runtime probes enough time for first-load initialization", () => {
    expect(
      resolveLlamaRuntimePreflightTimeoutMs({ backend: "rocm" }),
    ).toBeGreaterThanOrEqual(120000);
    expect(
      resolveLlamaRuntimePreflightTimeoutMs({ backend: "hip" }),
    ).toBeGreaterThanOrEqual(120000);
    expect(resolveLlamaRuntimePreflightTimeoutMs({ backend: "vulkan" })).toBe(
      20000,
    );
    expect(
      resolveLlamaRuntimePreflightTimeoutMs(
        { backend: "rocm" },
        { llamaRuntimePreflightTimeoutMs: 45000 },
      ),
    ).toBe(45000);
  });
});
