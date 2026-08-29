import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPageExportImageBuffer,
  assertPageExportPngBuffer,
  assertPageExportRasterBudget,
  buildBoundedPageExportDataUrl,
  decodeBoundedPageExportImage,
  decodeBoundedPageExportScreenshot,
  probePageExportSourceImage,
} from "../src/main/pageExportRasterSafety";
import { ORIGINAL_PAGE_EXPORT_RASTER_LIMITS } from "../src/shared/pageExportLimits";

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
      /실제 해상도 5000 × 12000|actual .*5000 × 12000/i,
    );
  });

  it("reports the actual unsupported dimensions instead of a pixel-count budget", () => {
    expect(() =>
      assertPageExportRasterBudget(
        { width: 10_001, height: 12_000 },
        "huge.png",
        ORIGINAL_PAGE_EXPORT_RASTER_LIMITS,
      ),
    ).toThrow(
      "huge.png 페이지의 실제 해상도 10001 × 12000가 지원 범위를 초과합니다.",
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
    ).toThrow(/실제 해상도 5000 × 12000|actual .*5000 × 12000/i);
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

  it.each([
    {
      bytes: makeJpegHeader(4445, 6053),
      format: "jpeg" as const,
      label: "page.jpg",
    },
    {
      bytes: makeVp8xWebp(4445, 6053),
      format: "webp" as const,
      label: "page.webp",
    },
  ])(
    "validates a bounded $format tile-stitch result",
    ({ bytes, format, label }) => {
      const expected = { width: 4445, height: 6053 };
      const encoded = bytes.toString("base64");

      expect(
        decodeBoundedPageExportImage(encoded, expected, label, format, {
          maxBase64Chars: encoded.length,
          maxPngBytes: bytes.length,
          rasterLimits: ORIGINAL_PAGE_EXPORT_RASTER_LIMITS,
        }),
      ).toEqual(bytes);
      expect(
        assertPageExportImageBuffer(
          bytes,
          expected,
          label,
          format,
          bytes.length,
          ORIGINAL_PAGE_EXPORT_RASTER_LIMITS,
        ),
      ).toEqual(expected);
    },
  );

  it("rejects a stitched image with the wrong format, size, or byte budget", () => {
    const jpeg = makeJpegHeader(16, 17);
    const webp = makeVp8xWebp(16, 17);

    expect(() =>
      assertPageExportImageBuffer(
        webp,
        { width: 16, height: 17 },
        "page.jpg",
        "jpeg",
      ),
    ).toThrow(/base64|PNG data/i);
    expect(() =>
      assertPageExportImageBuffer(
        jpeg,
        { width: 16, height: 16 },
        "page.jpg",
        "jpeg",
      ),
    ).toThrow(/일치하지|do not match/i);
    expect(() =>
      assertPageExportImageBuffer(
        jpeg,
        { width: 16, height: 17 },
        "page.jpg",
        "jpeg",
        1,
      ),
    ).toThrow(/파일 크기|file size/i);
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
