import { createRequire } from "node:module";
import { createWriteStream } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { describe, expect, it, vi } from "vitest";
import * as yazl from "yazl";

const require = createRequire(import.meta.url);
const {
  DEFAULT_RUNTIME_ARCHIVE_EXTRACTION_LIMITS,
  MAX_RUNTIME_ARCHIVE_ENTRY_BYTES,
  MAX_RUNTIME_ARCHIVE_ENTRY_COUNT,
  MAX_RUNTIME_ARCHIVE_EXPANDED_BYTES,
  addArchiveEntryToBudget,
  createArchiveExtractionDeadline,
  resolveArchiveExtractionLimits,
} = require("../src/main/runtime/archive-extraction-policy.cjs") as {
  DEFAULT_RUNTIME_ARCHIVE_EXTRACTION_LIMITS: {
    maximumEntries: number;
    maximumEntryBytes: number;
    maximumExpandedBytes: number;
    maximumCompressionRatio: number;
  };
  MAX_RUNTIME_ARCHIVE_ENTRY_BYTES: number;
  MAX_RUNTIME_ARCHIVE_ENTRY_COUNT: number;
  MAX_RUNTIME_ARCHIVE_EXPANDED_BYTES: number;
  addArchiveEntryToBudget: (
    budget: { entryCount: number; expandedBytes: number },
    entry: {
      name: string;
      size: number;
      compressedSize?: number;
      directory?: boolean;
    },
    archiveLabel: string,
    limits?: {
      maximumEntries: number;
      maximumEntryBytes: number;
      maximumExpandedBytes: number;
      maximumCompressionRatio: number;
    },
  ) => void;
  createArchiveExtractionDeadline: (
    signal?: AbortSignal,
    deadlineMs?: number,
  ) => { signal: AbortSignal; cleanup: () => void };
  resolveArchiveExtractionLimits: (overrides?: {
    maximumEntries?: number;
    maximumEntryBytes?: number;
    maximumExpandedBytes?: number;
    maximumCompressionRatio?: number;
  }) => {
    maximumEntries: number;
    maximumEntryBytes: number;
    maximumExpandedBytes: number;
    maximumCompressionRatio: number;
  };
};
const { extractSelectedZipEntries, normalizeSafeZipPath } =
  require("../src/main/runtime/simple-page-zip-utils.cjs") as {
    extractSelectedZipEntries: (
      archivePath: string,
      outputDir: string,
      shouldExtract: (name: string, relativePath: string) => boolean,
      options?: {
        finalOutputDir?: string;
        limits?: {
          maximumEntries?: number;
          maximumEntryBytes?: number;
          maximumExpandedBytes?: number;
          maximumCompressionRatio?: number;
        };
      },
    ) => Promise<void>;
    normalizeSafeZipPath: (value: string) => string;
  };
const { shouldExtractLlamaRuntimeFile } =
  require("../src/main/runtime/simple-page-llama-runtimes.cjs") as {
    shouldExtractLlamaRuntimeFile: (
      fileName: string,
      relativePath?: string,
    ) => boolean;
  };
const { replaceDirectoryWithRollback } =
  require("../src/main/runtime/runtime-directory-publish.cjs") as {
    replaceDirectoryWithRollback: (
      stagingDir: string,
      outputDir: string,
    ) => Promise<void>;
  };

describe("runtime archive extraction policy", () => {
  it("rejects entry-count and compression-ratio bombs before extraction", () => {
    const countBudget = {
      entryCount: MAX_RUNTIME_ARCHIVE_ENTRY_COUNT,
      expandedBytes: 0,
    };
    expect(() =>
      addArchiveEntryToBudget(
        countBudget,
        { name: "overflow", size: 0, compressedSize: 0 },
        "runtime.zip",
      ),
    ).toThrow(/too many entries/);

    expect(() =>
      addArchiveEntryToBudget(
        { entryCount: 0, expandedBytes: 0 },
        { name: "bomb.dll", size: 101_000, compressedSize: 1_000 },
        "runtime.zip",
      ),
    ).toThrow(/compression ratio/);
  });

  it("supports a caller-pinned larger archive budget without changing defaults", () => {
    const limits = resolveArchiveExtractionLimits({
      maximumEntries: MAX_RUNTIME_ARCHIVE_ENTRY_COUNT + 1,
      maximumExpandedBytes: 5 * 1024 * 1024 * 1024,
    });
    const budget = {
      entryCount: MAX_RUNTIME_ARCHIVE_ENTRY_COUNT,
      expandedBytes: 4 * 1024 * 1024 * 1024,
    };

    expect(() =>
      addArchiveEntryToBudget(
        budget,
        { name: "pinned-runtime.dll", size: 1, compressedSize: 1 },
        "pinned-runtime.zip",
        limits,
      ),
    ).not.toThrow();
    expect(budget).toEqual({
      entryCount: MAX_RUNTIME_ARCHIVE_ENTRY_COUNT + 1,
      expandedBytes: 4 * 1024 * 1024 * 1024 + 1,
    });

    expect(() => resolveArchiveExtractionLimits({ maximumEntries: 0 })).toThrow(
      "maximumEntries",
    );
  });

  it("keeps global limits while allowing only the pinned HIP entry size", () => {
    const ggmlHipBytes = 1_515_477_504;
    expect(MAX_RUNTIME_ARCHIVE_ENTRY_BYTES).toBe(1024 * 1024 * 1024);
    expect(MAX_RUNTIME_ARCHIVE_EXPANDED_BYTES).toBe(4 * 1024 * 1024 * 1024);

    const entry = {
      name: "ggml-hip.dll",
      size: ggmlHipBytes,
      compressedSize: 330_348_185,
    };
    expect(() =>
      addArchiveEntryToBudget(
        { entryCount: 0, expandedBytes: 0 },
        entry,
        "beellama.zip",
      ),
    ).toThrow(/entry is too large/);

    const pinnedLimits = resolveArchiveExtractionLimits({
      maximumEntryBytes: ggmlHipBytes,
    });
    expect(pinnedLimits).toEqual({
      ...DEFAULT_RUNTIME_ARCHIVE_EXTRACTION_LIMITS,
      maximumEntryBytes: ggmlHipBytes,
    });
    expect(() =>
      addArchiveEntryToBudget(
        { entryCount: 0, expandedBytes: 0 },
        entry,
        "beellama.zip",
        pinnedLimits,
      ),
    ).not.toThrow();
    expect(() =>
      addArchiveEntryToBudget(
        { entryCount: 0, expandedBytes: 0 },
        { ...entry, size: ggmlHipBytes + 1 },
        "beellama.zip",
        pinnedLimits,
      ),
    ).toThrow(/entry is too large/);
    expect(() =>
      addArchiveEntryToBudget(
        { entryCount: 0, expandedBytes: MAX_RUNTIME_ARCHIVE_EXPANDED_BYTES },
        { name: "overflow.dll", size: 1, compressedSize: 1 },
        "beellama.zip",
        pinnedLimits,
      ),
    ).toThrow(/expands beyond/);
  });

  it("applies scoped limits to unselected ZIP entries before publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "mgt-runtime-limits-"));
    const archivePath = join(root, "runtime.zip");
    const outputDir = join(root, "runtime");
    try {
      const zip = new yazl.ZipFile();
      zip.addBuffer(Buffer.from("ok"), "selected.dll");
      zip.addBuffer(Buffer.from("12345"), "unselected.bin");
      zip.end();
      await pipeline(zip.outputStream, createWriteStream(archivePath));

      await expect(
        extractSelectedZipEntries(
          archivePath,
          outputDir,
          (name) => name === "selected.dll",
          { limits: { maximumEntryBytes: 4 } },
        ),
      ).rejects.toThrow(/unselected\.bin/);

      await extractSelectedZipEntries(
        archivePath,
        outputDir,
        (name) => name === "selected.dll",
        {
          limits: {
            maximumEntries: 2,
            maximumEntryBytes: 5,
            maximumExpandedBytes: 7,
          },
        },
      );
      expect(await readFile(join(outputDir, "selected.dll"), "utf8")).toBe(
        "ok",
      );
      await expect(
        readFile(join(outputDir, "unselected.bin")),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a real ZIP with no selected runtime files", async () => {
    const root = await mkdtemp(join(tmpdir(), "mgt-runtime-no-match-"));
    const archivePath = join(root, "runtime.zip");
    const outputDir = join(root, "runtime");
    try {
      await writeZip(archivePath, [["docs/readme.txt", "documentation"]]);
      await mkdir(outputDir);
      await writeFile(join(outputDir, "known-good.dll"), "known-good");

      let caught: unknown;
      try {
        await extractSelectedZipEntries(
          archivePath,
          outputDir,
          shouldExtractLlamaRuntimeFile,
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("No runtime files matched");
      expect(caught).toMatchObject({
        archivePath,
        extractionMethod: "yauzl",
      });
      expect(await readFile(join(outputDir, "known-good.dll"), "utf8")).toBe(
        "known-good",
      );
      await expect(readFile(join(outputDir, "readme.txt"))).rejects.toThrow();
      expect(
        (await readdir(root)).some((name) => /^\.z-[a-f0-9]{16}$/.test(name)),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renames selected files, preserves ROCm paths, and keeps archive order", async () => {
    const root = await mkdtemp(join(tmpdir(), "mgt-runtime-rename-"));
    const firstArchive = join(root, "first.zip");
    const secondArchive = join(root, "second.zip");
    const outputDir = join(root, "runtime");
    try {
      await writeZip(firstArchive, [
        ["bin/llama-server.exe", "first-server"],
        ["bin/ggml-hip.dll", "first-backend"],
        ["rocblas/library/TensileLibrary_gfx1101.dat", "rocblas-kernel"],
        ["hipblaslt/library/Kernels-gfx1101.hsaco", "hipblaslt-kernel"],
        ["docs/readme.txt", "excluded"],
      ]);
      await writeZip(secondArchive, [
        ["replacement/ggml-hip.dll", "second-backend"],
      ]);

      await extractSelectedZipEntries(
        firstArchive,
        outputDir,
        shouldExtractLlamaRuntimeFile,
      );
      await extractSelectedZipEntries(
        secondArchive,
        outputDir,
        shouldExtractLlamaRuntimeFile,
      );

      expect(await readFile(join(outputDir, "llama-server.exe"), "utf8")).toBe(
        "first-server",
      );
      expect(await readFile(join(outputDir, "ggml-hip.dll"), "utf8")).toBe(
        "second-backend",
      );
      expect(
        await readFile(
          join(outputDir, "rocblas", "library", "TensileLibrary_gfx1101.dat"),
          "utf8",
        ),
      ).toBe("rocblas-kernel");
      expect(
        await readFile(
          join(outputDir, "hipblaslt", "library", "Kernels-gfx1101.hsaco"),
          "utf8",
        ),
      ).toBe("hipblaslt-kernel");
      await expect(readFile(join(outputDir, "readme.txt"))).rejects.toThrow();

      const source = await readFile(
        join(process.cwd(), "src/main/runtime/simple-page-zip-utils.cjs"),
        "utf8",
      );
      expect(source).toContain("await rename(selected.filePath, outputPath)");
      expect(source).not.toMatch(/\bcopyFile(?:Sync)?\b/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects absolute, traversal, and NUL entry paths", () => {
    expect(() => normalizeSafeZipPath("../escape.dll")).toThrow(/unsafe path/);
    expect(() => normalizeSafeZipPath("C:/escape.dll")).toThrow(/unsafe path/);
    expect(() => normalizeSafeZipPath("safe/evil\0.dll")).toThrow(
      /unsafe path/,
    );
  });

  it("rejects an overlong Windows selected path before extraction", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(join(tmpdir(), "mgt-runtime-long-path-"));
    const archivePath = join(root, "runtime.zip");
    const outputDir = join(root, "s");
    const outputName = "cudnn_engines_runtime_compiled64_9.dll";
    const baseFinalPath = resolve(join(root, "final-", outputName));
    const finalOutputDir = join(
      root,
      `final-${"f".repeat(252 - baseFinalPath.length)}`,
    );
    const finalPath = resolve(join(finalOutputDir, outputName));
    expect(finalPath).toHaveLength(252);
    try {
      await writeZip(archivePath, [[outputName, "selected"]]);

      await expect(
        extractSelectedZipEntries(
          archivePath,
          outputDir,
          (name) => name.endsWith(".dll"),
          { finalOutputDir },
        ),
      ).rejects.toMatchObject({
        runtimePath: finalPath,
        runtimePathLength: 252,
        windowsPathCeiling: 252,
        windowsPathUnsafe: true,
        nonRetriable: true,
      });
      await expect(readFile(join(outputDir, outputName))).rejects.toThrow();
      expect(
        (await readdir(root)).some((name) => /^\.z-[a-f0-9]{16}$/.test(name)),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("links cancellation and enforces an absolute extraction deadline", () => {
    vi.useFakeTimers();
    try {
      const parent = new AbortController();
      const linked = createArchiveExtractionDeadline(parent.signal, 100);
      parent.abort(new Error("cancelled"));
      expect(linked.signal.aborted).toBe(true);
      linked.cleanup();

      const deadline = createArchiveExtractionDeadline(undefined, 100);
      vi.advanceTimersByTime(100);
      expect(deadline.signal.aborted).toBe(true);
      expect(deadline.signal.reason).toEqual(
        expect.objectContaining({
          message: "Archive extraction deadline exceeded.",
        }),
      );
      deadline.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the previous runtime when staged publication fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "mgt-runtime-publish-"));
    const outputDir = join(root, "runtime");
    try {
      await mkdir(outputDir);
      await writeFile(join(outputDir, "server.exe"), "known-good", "utf8");

      await expect(
        replaceDirectoryWithRollback(join(root, "missing-staging"), outputDir),
      ).rejects.toThrow();

      expect(await readFile(join(outputDir, "server.exe"), "utf8")).toBe(
        "known-good",
      );
      expect(
        (await readdir(root)).some((name) => /^\.b-[a-f0-9]{16}$/.test(name)),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeZip(
  archivePath: string,
  entries: ReadonlyArray<readonly [name: string, content: string]>,
): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const [name, content] of entries) {
    zip.addBuffer(Buffer.from(content), name);
  }
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(archivePath));
}
