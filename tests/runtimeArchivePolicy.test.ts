import { createRequire } from "node:module";
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
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  MAX_RUNTIME_ARCHIVE_ENTRY_COUNT,
  addArchiveEntryToBudget,
  createArchiveExtractionDeadline,
} = require("../src/main/runtime/archive-extraction-policy.cjs") as {
  MAX_RUNTIME_ARCHIVE_ENTRY_COUNT: number;
  addArchiveEntryToBudget: (
    budget: { entryCount: number; expandedBytes: number },
    entry: {
      name: string;
      size: number;
      compressedSize?: number;
      directory?: boolean;
    },
    archiveLabel: string,
  ) => void;
  createArchiveExtractionDeadline: (
    signal?: AbortSignal,
    deadlineMs?: number,
  ) => { signal: AbortSignal; cleanup: () => void };
};
const { normalizeSafeZipPath } =
  require("../src/main/runtime/simple-page-zip-utils.cjs") as {
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
