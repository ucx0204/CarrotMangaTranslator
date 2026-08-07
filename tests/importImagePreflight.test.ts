import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportImageRuntime } from "../src/main/libraryStore/importImageRuntime";
import { materializePageRecord } from "../src/main/libraryStore/importPageMaterialize";
import type { ZipArchiveReader } from "../src/main/libraryStore/zipSafety";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("import image preflight", () => {
  it.each([
    ["PNG", "oversized.png", makePngHeader(20_000, 8_000)],
    ["JPEG", "oversized.jpg", makeJpegHeader(20_000, 8_000)],
    ["WebP", "oversized.webp", makeVp8xWebp(20_000, 8_000)],
  ])(
    "rejects oversized %s before any decoder starts",
    async (_kind, name, bytes) => {
      const { rootDir, pagesDir } = await createLayout();
      const sourcePath = join(rootDir, name);
      await writeFile(sourcePath, bytes);
      const runtime = makeRuntime();

      await expect(
        materializePageRecord(
          { name, sourceKind: "file", sourcePath },
          pagesDir,
          0,
          new Map(),
          runtime,
        ),
      ).rejects.toThrow(/해상도가 너무 큽니다/);

      expect(runtime.validateImageFile).not.toHaveBeenCalled();
      expect(runtime.convertWebpToPngFile).not.toHaveBeenCalled();
      expect(await readdir(pagesDir)).toEqual([]);
    },
  );

  it("rejects an oversized WebP ZIP entry before temp source or decoder", async () => {
    const { rootDir, pagesDir } = await createLayout();
    const archivePath = join(rootDir, "pages.zip");
    const bytes = makeVp8xWebp(20_000, 8_000);
    const reader = makeZipReader("001.webp", bytes);
    const cache = new Map<string, ZipArchiveReader>([[archivePath, reader]]);
    const runtime = makeRuntime();

    await expect(
      materializePageRecord(
        {
          name: "001.webp",
          sourceKind: "zip-entry",
          sourcePath: archivePath,
          zipEntryName: "001.webp",
        },
        pagesDir,
        0,
        cache,
        runtime,
      ),
    ).rejects.toThrow(/해상도가 너무 큽니다/);

    expect(runtime.validateImageFile).not.toHaveBeenCalled();
    expect(runtime.convertWebpToPngFile).not.toHaveBeenCalled();
    expect(await readdir(pagesDir)).toEqual([]);
  });

  it("validates a stored PNG in the isolated decoder and stores actual dimensions", async () => {
    const { rootDir, pagesDir } = await createLayout();
    const sourcePath = join(rootDir, "001.png");
    await writeFile(sourcePath, makePngHeader(2, 3));
    const runtime = makeRuntime();

    const page = await materializePageRecord(
      { name: "001.png", sourceKind: "file", sourcePath },
      pagesDir,
      0,
      new Map(),
      runtime,
    );

    expect(page.width).toBe(2);
    expect(page.height).toBe(3);
    expect(runtime.validateImageFile).toHaveBeenCalledTimes(1);
    expect(runtime.convertWebpToPngFile).not.toHaveBeenCalled();
  });

  it("normalizes WebP to an output PNG file and validates the final file", async () => {
    const { rootDir, pagesDir } = await createLayout();
    const sourcePath = join(rootDir, "001.webp");
    await writeFile(sourcePath, makeVp8xWebp(2, 3));
    const runtime = makeRuntime({ conversionOutput: makePngHeader(2, 3) });

    const page = await materializePageRecord(
      { name: "001.webp", sourceKind: "file", sourcePath },
      pagesDir,
      0,
      new Map(),
      runtime,
    );

    expect(page.imagePath).toMatch(/\.png$/);
    expect(page.width).toBe(2);
    expect(page.height).toBe(3);
    expect(runtime.convertWebpToPngFile).toHaveBeenCalledTimes(1);
    expect(runtime.validateImageFile).toHaveBeenCalledTimes(1);
    const conversionCall = vi.mocked(runtime.convertWebpToPngFile).mock
      .calls[0];
    expect(conversionCall?.[0]).toBe(sourcePath);
    expect(conversionCall?.[1]).toBe(page.imagePath);
  });

  it("rejects WebP conversion dimension changes and removes partial output", async () => {
    const { rootDir, pagesDir } = await createLayout();
    const sourcePath = join(rootDir, "001.webp");
    await writeFile(sourcePath, makeVp8xWebp(1, 1));
    const runtime = makeRuntime({ conversionOutput: makePngHeader(2, 1) });

    await expect(
      materializePageRecord(
        { name: "001.webp", sourceKind: "file", sourcePath },
        pagesDir,
        0,
        new Map(),
        runtime,
      ),
    ).rejects.toThrow(/치수가 원본과 다릅니다/);

    expect(runtime.convertWebpToPngFile).toHaveBeenCalledTimes(1);
    expect(runtime.validateImageFile).not.toHaveBeenCalled();
    expect(await readdir(pagesDir)).toEqual([]);
  });

  it("rejects a truncated converted output and removes it", async () => {
    const { rootDir, pagesDir } = await createLayout();
    const sourcePath = join(rootDir, "001.webp");
    await writeFile(sourcePath, makeVp8xWebp(1, 1));
    const runtime = makeRuntime({
      conversionOutput: Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]),
    });

    await expect(
      materializePageRecord(
        { name: "001.webp", sourceKind: "file", sourcePath },
        pagesDir,
        0,
        new Map(),
        runtime,
      ),
    ).rejects.toThrow(/헤더/);

    expect(runtime.validateImageFile).not.toHaveBeenCalled();
    expect(await readdir(pagesDir)).toEqual([]);
  });
});

async function createLayout(): Promise<{ rootDir: string; pagesDir: string }> {
  const rootDir = await mkdtemp(join(tmpdir(), "import-image-preflight-"));
  tempDirs.push(rootDir);
  const pagesDir = join(rootDir, "pages");
  await mkdir(pagesDir, { recursive: true });
  return { rootDir, pagesDir };
}

function makeRuntime({
  conversionOutput = makePngHeader(1, 1),
}: {
  conversionOutput?: Buffer;
} = {}): ImportImageRuntime {
  return {
    validateImageFile: vi.fn(async () => undefined),
    convertWebpToPngFile: vi.fn(async (_sourcePath, outputPath) => {
      await writeFile(outputPath, conversionOutput);
    }),
  };
}

function makeZipReader(entryName: string, bytes: Buffer): ZipArchiveReader {
  const entry = { entryName, isDirectory: false };
  return {
    entries: [entry],
    entryMap: new Map([[entryName, entry]]),
    readEntry: vi.fn(async () => bytes),
    close: vi.fn(),
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

function makeJpegHeader(width: number, height: number): Buffer {
  const payload = Buffer.alloc(9);
  payload[0] = 8;
  payload.writeUInt16BE(height, 1);
  payload.writeUInt16BE(width, 3);
  payload[5] = 1;
  payload[6] = 1;
  payload[7] = 0x11;
  const segment = Buffer.alloc(4 + payload.length);
  segment.set([0xff, 0xc0], 0);
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment,
    Buffer.from([0xff, 0xd9]),
  ]);
}

function makeVp8xWebp(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10);
  writeUint24LE(payload, 4, width - 1);
  writeUint24LE(payload, 7, height - 1);
  const chunk = Buffer.alloc(18);
  chunk.write("VP8X", 0, "ascii");
  chunk.writeUInt32LE(payload.length, 4);
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
