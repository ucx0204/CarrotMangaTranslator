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
import { join } from "node:path";
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

  it("rejects absolute, traversal, and NUL entry paths", () => {
    expect(() => normalizeSafeZipPath("../escape.dll")).toThrow(/unsafe path/);
    expect(() => normalizeSafeZipPath("C:/escape.dll")).toThrow(/unsafe path/);
    expect(() => normalizeSafeZipPath("safe/evil\0.dll")).toThrow(
      /unsafe path/,
    );
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
        (await readdir(root)).some((name) => name.includes(".backup-")),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
