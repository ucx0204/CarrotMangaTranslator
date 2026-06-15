import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const AdmZip = require("adm-zip") as {
  new (): {
    addFile: (name: string, data: Buffer) => void;
    writeZip: (path: string) => void;
  };
};
import {
  isSupportedArchivePath,
  SUPPORTED_ARCHIVE_EXTENSIONS,
} from "../src/main/libraryStore/importSources";
import {
  assertZipEntryBudget,
  assertZipEntrySize,
  readZipEntryData,
  readZipEntryDataFromFile,
  type ZipEntryLike,
} from "../src/main/libraryStore/zipSafety";

function zipEntry(partial: Partial<ZipEntryLike>): ZipEntryLike {
  return {
    entryName: "001.png",
    isDirectory: false,
    header: {
      size: 10,
      compressedSize: 10,
    },
    getData: () => Buffer.from("0123456789"),
    ...partial,
  };
}

describe("zip safety", () => {
  it("uses one archive extension allowlist for zip and cbz", () => {
    expect(SUPPORTED_ARCHIVE_EXTENSIONS).toEqual([".zip", ".cbz"]);
    expect(isSupportedArchivePath("chapter.zip")).toBe(true);
    expect(isSupportedArchivePath("chapter.cbz")).toBe(true);
    expect(isSupportedArchivePath("chapter.rar")).toBe(false);
  });

  it("rejects entries without trustworthy size metadata before extraction", () => {
    expect(() =>
      assertZipEntrySize(zipEntry({ header: {} }), 100, "bad.png"),
    ).toThrow(/크기를 확인/);
    expect(() =>
      readZipEntryData(zipEntry({ header: { size: 10 } }), 100, "bad.png"),
    ).toThrow(/압축 크기/);
  });

  it("rejects suspicious compression ratios before extraction", () => {
    const suspicious = zipEntry({
      header: { size: 100_000, compressedSize: 1 },
    });
    expect(() => assertZipEntryBudget([suspicious], "ZIP 파일")).toThrow(
      /압축률/,
    );
  });

  it("reads archive entry bytes through the streaming reader", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mgt-zip-safety-"));
    try {
      const archivePath = join(dir, "chapter.cbz");
      const zip = new AdmZip();
      zip.addFile("001.txt", Buffer.from("hello"));
      zip.writeZip(archivePath);

      await expect(
        readZipEntryDataFromFile(archivePath, "001.txt", 4, "001.txt"),
      ).rejects.toThrow(/너무 큽니다/);
      await expect(
        readZipEntryDataFromFile(archivePath, "001.txt", 16, "001.txt"),
      ).resolves.toEqual(Buffer.from("hello"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
