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
import { isSupportedArchivePath } from "../src/main/libraryStore/importSources";
import { SUPPORTED_ARCHIVE_EXTENSIONS } from "../src/shared/archive";
import {
  assertZipEntryBudget,
  assertZipEntrySize,
  createZipEntryBudgetTracker,
  MAX_ZIP_ENTRY_COUNT,
  MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
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
  it("uses one archive extension allowlist for ZIP/CBZ/RAR/CBR", () => {
    expect(SUPPORTED_ARCHIVE_EXTENSIONS).toEqual([
      ".zip",
      ".cbz",
      ".rar",
      ".cbr",
    ]);
    expect(isSupportedArchivePath("chapter.zip")).toBe(true);
    expect(isSupportedArchivePath("chapter.cbz")).toBe(true);
    expect(isSupportedArchivePath("chapter.rar")).toBe(true);
    expect(isSupportedArchivePath("chapter.CBR")).toBe(true);
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

  it("shares the 10000-entry budget with incremental export tracking", () => {
    const tracker = createZipEntryBudgetTracker("공유 파일");
    for (let index = 0; index < MAX_ZIP_ENTRY_COUNT; index += 1) {
      tracker.addEntry(0, `entry-${index}`);
    }
    expect(tracker.entryCount).toBe(MAX_ZIP_ENTRY_COUNT);
    expect(() => tracker.addEntry(0, "overflow")).toThrow(/항목이 너무 많/);
  });

  it("shares the 4 GiB uncompressed budget with incremental export tracking", () => {
    const tracker = createZipEntryBudgetTracker("공유 파일");
    tracker.addEntry(MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES, "full.bin");
    expect(tracker.totalUncompressedBytes).toBe(
      MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
    );
    expect(() => tracker.addEntry(1, "overflow.bin")).toThrow(
      /압축 해제 크기가 너무 큽니다/,
    );
  });

  it("rejects invalid incremental entry sizes", () => {
    const tracker = createZipEntryBudgetTracker("공유 파일");
    expect(() => tracker.addEntry(-1, "negative.bin")).toThrow(
      /크기가 올바르지/,
    );
    expect(() => tracker.addEntry(Number.NaN, "nan.bin")).toThrow(
      /크기가 올바르지/,
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
