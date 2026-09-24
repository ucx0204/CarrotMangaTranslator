import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { writeAtomicStreamingShareArchive } from "../src/main/libraryStore/shareStreamingZip";
import type { ShareArchiveLimits } from "../src/main/libraryStore/shareArchiveLimits";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "share-explicit-limits-"));
  directories.push(directory);
  const outputPath = join(directory, "work.mgtshare");
  const write = (limits?: ShareArchiveLimits) =>
    writeAtomicStreamingShareArchive(
      {
        outputPath,
        archiveDate: new Date("2026-01-01T00:00:00.000Z"),
        limits,
      },
      async (archive) => {
        await archive.addJson("manifest.json", {});
        await archive.addJson("style-guide.json", {});
      },
    );
  return { directory, outputPath, write };
}

it("preserves native bytes without limits and at the exact actual ZIP byte limit", async () => {
  const f = await fixture();
  await f.write();
  const expected = await readFile(f.outputPath);
  await f.write({
    maxOutputBytes: expected.length,
    maxEntries: 2,
    maxUncompressedBytes: 6,
  });
  expect(await readFile(f.outputPath)).toEqual(expected);
  expect(await readdir(f.directory)).toEqual(["work.mgtshare"]);
});

it("stops actual output one byte over its cap and preserves the previous target", async () => {
  const f = await fixture();
  await f.write();
  const expected = await readFile(f.outputPath);
  const original = Buffer.from("previous-output");
  await writeFile(f.outputPath, original);
  await expect(
    f.write({
      maxOutputBytes: expected.length - 1,
      maxEntries: 2,
      maxUncompressedBytes: 6,
    }),
  ).rejects.toThrow(/output byte limit/);
  expect(await readFile(f.outputPath)).toEqual(original);
  expect(await readdir(f.directory)).toEqual(["work.mgtshare"]);
});

it.each([
  { maxOutputBytes: 1024, maxEntries: 1, maxUncompressedBytes: 6 },
  { maxOutputBytes: 1024, maxEntries: 2, maxUncompressedBytes: 5 },
])(
  "rejects an actual entry or expanded-byte overrun without publishing",
  async (limits) => {
    const f = await fixture();
    await expect(f.write(limits)).rejects.toThrow(
      /entry or expanded byte limit/,
    );
    expect(await readdir(f.directory)).toEqual([]);
  },
);

it.each([
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
])(
  "rejects invalid per-export limits before creating an output (%s)",
  async (invalid) => {
    const f = await fixture();
    for (const key of [
      "maxOutputBytes",
      "maxEntries",
      "maxUncompressedBytes",
    ] as const) {
      await expect(
        f.write({
          maxOutputBytes: 1024,
          maxEntries: 2,
          maxUncompressedBytes: 6,
          [key]: invalid,
        }),
      ).rejects.toThrow(/positive safe integers/);
    }
    expect(await readdir(f.directory)).toEqual([]);
  },
);
