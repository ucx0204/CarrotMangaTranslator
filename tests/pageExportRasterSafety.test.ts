import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPageExportPngBuffer,
  buildBoundedPageExportDataUrl,
  decodeBoundedPageExportScreenshot,
  probePageExportSourceImage,
} from "../src/main/pageExportRasterSafety";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("page export raster safety", () => {
  it("probes actual source dimensions from the image header", async () => {
    const imagePath = await writeTempPng(2048, 8192);

    await expect(probePageExportSourceImage(imagePath)).resolves.toEqual({
      width: 2048,
      height: 8192,
    });
  });

  it("rejects an oversized source during the file-header preflight", async () => {
    const imagePath = await writeTempPng(5000, 12000);

    await expect(probePageExportSourceImage(imagePath)).rejects.toThrow(
      /안전 해상도|raster safety/i,
    );
  });
  it("accepts a bounded PNG with the expected dimensions", () => {
    expect(
      assertPageExportPngBuffer(
        fakePng(4096, 4096),
        { width: 4096, height: 4096 },
        "page.png",
      ),
    ).toEqual({ width: 4096, height: 4096 });
  });

  it("rejects a PNG that declares an oversized raster", () => {
    expect(() =>
      assertPageExportPngBuffer(fakePng(5000, 12000), undefined, "page.png"),
    ).toThrow(/안전 해상도|raster safety/i);
  });

  it("rejects a PNG whose dimensions differ from the expected output", () => {
    expect(() =>
      assertPageExportPngBuffer(
        fakePng(1000, 1999),
        { width: 1000, height: 2000 },
        "page.png",
      ),
    ).toThrow(/일치하지|do not match/i);
  });

  it("applies the PNG byte cap before parsing the buffer", () => {
    expect(() =>
      assertPageExportPngBuffer(fakePng(16, 16), undefined, "page.png", 16),
    ).toThrow(/파일 크기|file size/i);
  });

  it("applies the base64 char cap before decoding", () => {
    expect(() =>
      decodeBoundedPageExportScreenshot(
        "YWJjYWJj",
        { width: 1, height: 1 },
        "page.png",
        { maxBase64Chars: 4, maxPngBytes: 8 },
      ),
    ).toThrow(/파일 크기|file size/i);
  });

  it("applies the estimated decoded byte cap before Buffer allocation", () => {
    expect(() =>
      decodeBoundedPageExportScreenshot(
        "YWJj",
        { width: 1, height: 1 },
        "page.png",
        { maxBase64Chars: 4, maxPngBytes: 2 },
      ),
    ).toThrow(/파일 크기|file size/i);
  });

  it("rejects invalid base64 length without accepting a screenshot", () => {
    expect(() =>
      decodeBoundedPageExportScreenshot(
        "abc",
        { width: 1, height: 1 },
        "page.png",
        { maxBase64Chars: 3, maxPngBytes: 3 },
      ),
    ).toThrow(/base64|PNG data/i);
  });

  it("decodes a bounded screenshot and rechecks PNG dimensions", () => {
    const encoded = fakePng(16, 16).toString("base64");
    expect(
      decodeBoundedPageExportScreenshot(
        encoded,
        { width: 16, height: 16 },
        "page.png",
        { maxBase64Chars: encoded.length, maxPngBytes: 24 },
      ),
    ).toEqual(fakePng(16, 16));
  });

  it("builds a bounded fallback data URL without native image decoding", () => {
    expect(
      buildBoundedPageExportDataUrl(
        fakePng(16, 16),
        { width: 16, height: 16 },
        "page.png",
      ),
    ).toBe(`data:image/png;base64,${fakePng(16, 16).toString("base64")}`);
  });

  it("rejects fallback bytes if their dimensions changed after preflight", () => {
    expect(() =>
      buildBoundedPageExportDataUrl(
        fakePng(16, 15),
        { width: 16, height: 16 },
        "page.png",
      ),
    ).toThrow(/검사 후 변경|changed after validation/i);
  });
});

async function writeTempPng(width: number, height: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "page-export-raster-"));
  tempDirs.push(dir);
  const imagePath = join(dir, "page.png");
  await writeFile(imagePath, fakePng(width, height));
  return imagePath;
}

function fakePng(width: number, height: number): Buffer {
  const png = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
  png.writeUInt32BE(13, 8);
  Buffer.from("IHDR", "ascii").copy(png, 12);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}
