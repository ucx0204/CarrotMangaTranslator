import { createRequire } from "node:module";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import * as yazl from "yazl";

const require = createRequire(import.meta.url);
const {
  calculateFileSha256,
  claimRuntimeArchivePaths,
  extractRuntimeArchives,
  verifyRuntimeArchiveChecksums,
} = require("../src/main/runtime/model/llama-runtime-download.cjs") as {
  calculateFileSha256: (filePath: string) => Promise<string>;
  claimRuntimeArchivePaths: (archivePaths: string[]) => Promise<{
    archivePaths: readonly string[];
    restore: () => Promise<void>;
  }>;
  extractRuntimeArchives: (
    runtimeDir: string,
    verifiedArchives: Array<{
      archivePath: string;
      archive: RuntimeArchive;
      sha256: string;
      bytes: number;
    }>,
    runtime: RuntimeDescriptor,
    options: { abortSignal?: AbortSignal },
    restoreArchivesBeforePublish: () => Promise<void>,
  ) => Promise<void>;
  verifyRuntimeArchiveChecksums: (
    archivePaths: readonly string[],
    archives: RuntimeArchive[],
  ) => Promise<
    Array<{
      archivePath: string;
      archive: RuntimeArchive;
      sha256: string;
      bytes: number;
    }>
  >;
};

type RuntimeArchive = {
  archive: string;
  url: string;
  sha256: string;
};

type RuntimeDescriptor = {
  id: string;
  kind: string;
  backend: string;
  dir: string;
  requiredFiles: string[];
};

const TEST_RUNTIME: RuntimeDescriptor = {
  id: "test-vulkan-runtime",
  kind: "test",
  backend: "vulkan",
  dir: "test-vulkan-runtime",
  requiredFiles: ["llama-server.exe", "ggml-vulkan.dll"],
};

describe("llama runtime archive ownership", () => {
  it("publishes only the claimed archive when the public cache path is swapped", async () => {
    const root = await mkdtemp(join(tmpdir(), "mgt-llama-owned-"));
    const archivePath = join(root, "runtime.zip");
    const runtimeDir = join(root, "installed-runtime");
    await writeRuntimeZip(archivePath, "trusted");
    const archive = await describeRuntimeArchive(archivePath);
    const ownership = await claimRuntimeArchivePaths([archivePath]);

    try {
      expect(ownership.archivePaths).toHaveLength(1);
      expect(ownership.archivePaths[0]).not.toBe(archivePath);
      await expect(access(archivePath)).rejects.toThrow();

      const verified = await verifyRuntimeArchiveChecksums(
        ownership.archivePaths,
        [archive],
      );

      // This is the stable path an attacker could swap after preverification.
      // Extraction must continue to consume only the claimed random path.
      await writeRuntimeZip(archivePath, "unverified");
      await extractRuntimeArchives(
        runtimeDir,
        verified,
        TEST_RUNTIME,
        {},
        ownership.restore,
      );

      expect(await readFile(join(runtimeDir, "llama-server.exe"), "utf8")).toBe(
        "trusted-server",
      );
      expect(await readFile(join(runtimeDir, "ggml-vulkan.dll"), "utf8")).toBe(
        "trusted-backend",
      );
      expect(await calculateFileSha256(archivePath)).toBe(archive.sha256);
    } finally {
      await ownership.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails before publication when the verified cache path cannot be restored", async () => {
    const root = await mkdtemp(join(tmpdir(), "mgt-llama-owned-blocked-"));
    const archivePath = join(root, "runtime.zip");
    const runtimeDir = join(root, "installed-runtime");
    await writeRuntimeZip(archivePath, "trusted");
    const archive = await describeRuntimeArchive(archivePath);
    const ownership = await claimRuntimeArchivePaths([archivePath]);

    try {
      const verified = await verifyRuntimeArchiveChecksums(
        ownership.archivePaths,
        [archive],
      );
      await mkdir(archivePath);

      await expect(
        extractRuntimeArchives(
          runtimeDir,
          verified,
          TEST_RUNTIME,
          {},
          ownership.restore,
        ),
      ).rejects.toThrow();
      await expect(access(runtimeDir)).rejects.toThrow();
    } finally {
      await rm(archivePath, { recursive: true, force: true });
      await ownership.restore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function describeRuntimeArchive(
  archivePath: string,
): Promise<RuntimeArchive> {
  return {
    archive: "runtime.zip",
    url: "https://example.invalid/runtime.zip",
    sha256: await calculateFileSha256(archivePath),
  };
}

async function writeRuntimeZip(
  archivePath: string,
  content: "trusted" | "unverified",
): Promise<void> {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(`${content}-server`), "llama-server.exe");
  zip.addBuffer(Buffer.from(`${content}-backend`), "ggml-vulkan.dll");
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(archivePath));
}
