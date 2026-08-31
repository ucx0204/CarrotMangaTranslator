import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportImageRuntime } from "../src/main/libraryStore/importImageRuntime";
import type { ChapterFile } from "../src/main/libraryStore/libraryFiles";
import { materializeSharedChapter } from "../src/main/libraryStore/shareImportMaterialize";
import type { ZipEntryLike } from "../src/main/libraryStore/zipSafety";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("shared image dimension safety", () => {
  it("stores original actual dimensions and accepts matching inpainted dimensions", async () => {
    const harness = await createHarness({
      original: makePngHeader(2, 3),
      inpainted: makePngHeader(2, 3),
      declaredWidth: 900,
      declaredHeight: 1200,
    });

    const chapter = await harness.materialize();
    const page = chapter.pages[0];
    expect(page).toMatchObject({ width: 2, height: 3 });
    expect(page?.inpaintedImagePath).toBeTruthy();
    expect(page?.inpaintMaskPath).toBeUndefined();
    expect(page?.maskProvenance).toBeUndefined();
    expect(existsSync(page?.imagePath ?? "")).toBe(true);
    expect(existsSync(page?.inpaintedImagePath ?? "")).toBe(true);
    expect(harness.validate).toHaveBeenCalledTimes(2);
  });

  it("rejects an inpainted dimension mismatch and rolls back the chapter directory", async () => {
    const harness = await createHarness({
      original: makePngHeader(2, 3),
      inpainted: makePngHeader(3, 2),
    });

    await expect(harness.materialize()).rejects.toThrow(
      /인페인팅 이미지 치수가 원본 이미지와 다릅니다/,
    );
    expect(await readdir(harness.chaptersDir)).toEqual([]);
  });

  it("rejects an oversized original before starting the decoder and rolls back", async () => {
    const harness = await createHarness({
      original: makePngHeader(20_000, 8_000),
      inpainted: makePngHeader(2, 3),
    });

    await expect(harness.materialize()).rejects.toThrow(/해상도가 너무 큽니다/);
    expect(harness.validate).not.toHaveBeenCalled();
    expect(harness.convert).not.toHaveBeenCalled();
    expect(await readdir(harness.chaptersDir)).toEqual([]);
  });

  it("rejects an oversized inpainted image before its decoder starts and rolls back", async () => {
    const harness = await createHarness({
      original: makePngHeader(2, 3),
      inpainted: makePngHeader(20_000, 8_000),
    });

    await expect(harness.materialize()).rejects.toThrow(/해상도가 너무 큽니다/);
    expect(harness.validate).toHaveBeenCalledTimes(1);
    expect(harness.convert).not.toHaveBeenCalled();
    expect(await readdir(harness.chaptersDir)).toEqual([]);
  });

  it("preflights and converts a matching inpainted WebP through the file API", async () => {
    const harness = await createHarness({
      original: makePngHeader(2, 3),
      inpainted: makeVp8xWebp(2, 3),
      convertedOutput: makePngHeader(2, 3),
      inpaintedExt: ".webp",
    });

    const chapter = await harness.materialize();
    expect(chapter.pages[0]?.inpaintedImagePath).toMatch(/\.png$/);
    expect(harness.convert).toHaveBeenCalledTimes(1);
    expect(harness.validate).toHaveBeenCalledTimes(2);
  });
});

async function createHarness({
  original,
  inpainted,
  declaredWidth = 100,
  declaredHeight = 120,
  convertedOutput = makePngHeader(2, 3),
  inpaintedExt = ".png",
}: {
  original: Buffer;
  inpainted: Buffer;
  declaredWidth?: number;
  declaredHeight?: number;
  convertedOutput?: Buffer;
  inpaintedExt?: ".png" | ".webp";
}) {
  const rootDir = await mkdtemp(join(tmpdir(), "share-image-dimension-"));
  tempDirs.push(rootDir);
  const chaptersDir = join(rootDir, "works", "work-1", "chapters");
  await mkdir(chaptersDir, { recursive: true });

  const validate = vi.fn(async () => undefined);
  const convert = vi.fn(async (_sourcePath: string, outputPath: string) => {
    await writeFile(outputPath, convertedOutput);
  });
  const imageRuntime: ImportImageRuntime = {
    validateImageFile: validate,
    convertWebpToPngFile: convert,
  };
  const writeChapter = vi.fn(async () => undefined);
  const removeChapter = vi.fn(async (_workId: string, chapterId: string) => {
    await rm(join(chaptersDir, chapterId), { recursive: true, force: true });
  });

  const originalPath = "chapters/source/pages/001.png";
  const inpaintedPath = `chapters/source/inpainted/001${inpaintedExt}`;
  const buffers = new Map<string, Buffer>([
    [originalPath, original],
    [inpaintedPath, inpainted],
  ]);
  const entries = new Map<string, ZipEntryLike>([
    [originalPath, { entryName: originalPath, isDirectory: false }],
    [inpaintedPath, { entryName: inpaintedPath, isDirectory: false }],
  ]);
  const archiveReader = {
    readEntry: vi.fn(async (entryName: string) => {
      const bytes = buffers.get(entryName);
      if (!bytes) {
        throw new Error(`missing fixture: ${entryName}`);
      }
      return bytes;
    }),
  };
  const packageChapter = makeChapter({
    originalPath,
    inpaintedPath,
    width: declaredWidth,
    height: declaredHeight,
  });
  return {
    chaptersDir,
    validate,
    convert,
    materialize: () =>
      materializeSharedChapter({
        workId: "work-1",
        packageChapter,
        entries,
        archiveReader,
        requestedTitle: "Imported",
        worksRoot: join(rootDir, "works"),
        imageRuntime,
        writeChapter,
        removeChapter,
      }),
  };
}

function makeChapter({
  originalPath,
  inpaintedPath,
  width,
  height,
}: {
  originalPath: string;
  inpaintedPath: string;
  width: number;
  height: number;
}): ChapterFile {
  return {
    id: "source-chapter",
    workId: "source-work",
    title: "Source",
    sourceKind: "folder",
    status: "idle",
    pageOrder: ["source-page"],
    pages: [
      {
        id: "source-page",
        name: "001.png",
        imagePath: originalPath,
        inpaintedImagePath: inpaintedPath,
        inpaintMaskPath:
          "C:\\source-library\\works\\work\\chapters\\chapter\\mask\\001.png",
        maskProvenance: "actual-mask",
        width,
        height,
        blocks: [],
        analysisStatus: "idle",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makePngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function makeVp8xWebp(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10);
  writeUint24LE(payload, 4, width - 1);
  writeUint24LE(payload, 7, height - 1);
  const chunk = Buffer.alloc(18);
  chunk.write("VP8X", 0, "ascii");
  chunk.writeUInt32LE(10, 4);
  payload.copy(chunk, 8);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + chunk.length, 4);
  header.write("WEBP", 8, "ascii");
  return Buffer.concat([header, chunk]);
}

function writeUint24LE(buffer: Buffer, offset: number, value: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
  buffer[offset + 2] = (value >> 16) & 0xff;
}
