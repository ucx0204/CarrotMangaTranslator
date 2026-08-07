import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  probeImageBuffer,
  probeImageFile,
} from "../src/main/libraryStore/imageHeaderProbe";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("image header preflight", () => {
  describe("PNG", () => {
    it.each([
      [1, 1],
      [1000, 2000],
      [12_000, 10_000],
    ])("reads %sx%s IHDR dimensions", (width, height) => {
      expect(
        probeImageBuffer(makePngHeader(width, height), "page.png"),
      ).toMatchObject({
        format: "png",
        encodedWidth: width,
        encodedHeight: height,
        width,
        height,
        orientation: 1,
        pixelCount: width * height,
      });
    });

    it("rejects a pixel count above the limit before pixel data exists", () => {
      expect(() =>
        probeImageBuffer(makePngHeader(12_001, 10_000), "oversized.png"),
      ).toThrow(/해상도가 너무 큽니다/);
    });

    it.each([
      [0, 1],
      [1, 0],
      [100_001, 1],
    ])("rejects invalid or overlong dimensions %sx%s", (width, height) => {
      expect(() =>
        probeImageBuffer(makePngHeader(width, height), "invalid.png"),
      ).toThrow();
    });

    it("requires a 13-byte IHDR as the first chunk", () => {
      const badLength = makePngHeader(1, 1);
      badLength.writeUInt32BE(12, 8);
      expect(() => probeImageBuffer(badLength, "bad-length.png")).toThrow(
        /헤더/,
      );

      const badChunk = makePngHeader(1, 1);
      badChunk.write("IDAT", 12, "ascii");
      expect(() => probeImageBuffer(badChunk, "bad-first-chunk.png")).toThrow(
        /헤더/,
      );
    });

    it("rejects truncated and invalid signatures", () => {
      expect(() =>
        probeImageBuffer(makePngHeader(1, 1).subarray(0, 23), "truncated.png"),
      ).toThrow(/헤더/);
      expect(() => probeImageBuffer(Buffer.alloc(24), "not-png.png")).toThrow(
        /헤더/,
      );
    });
  });

  describe("JPEG", () => {
    it.each([
      [0xc0, "baseline"],
      [0xc2, "progressive"],
    ])("reads %s SOF dimensions", (sofMarker) => {
      const metadata = probeImageBuffer(
        makeJpeg({ width: 640, height: 480, sofMarker }),
        "page.jpg",
      );
      expect(metadata).toMatchObject({
        format: "jpeg",
        encodedWidth: 640,
        encodedHeight: 480,
        width: 640,
        height: 480,
        orientation: 1,
      });
    });

    it("skips APP segments and repeated FF fill bytes", () => {
      const jpeg = makeJpeg({
        width: 321,
        height: 123,
        appSegments: [Buffer.from("profile")],
        fillBeforeSof: 3,
      });
      expect(probeImageBuffer(jpeg, "app.jpg")).toMatchObject({
        width: 321,
        height: 123,
      });
    });

    it.each([6, 8])(
      "applies EXIF orientation %s to display dimensions",
      (orientation) => {
        const metadata = probeImageBuffer(
          makeJpeg({ width: 1200, height: 800, orientation }),
          "rotated.jpg",
        );
        expect(metadata).toMatchObject({
          encodedWidth: 1200,
          encodedHeight: 800,
          width: 800,
          height: 1200,
          orientation,
        });
      },
    );

    it("keeps EXIF orientation 1 dimensions unchanged", () => {
      expect(
        probeImageBuffer(
          makeJpeg({ width: 1200, height: 800, orientation: 1 }),
          "normal.jpg",
        ),
      ).toMatchObject({ width: 1200, height: 800, orientation: 1 });
    });

    it("rejects missing SOF, bad segment lengths, and truncated SOF", () => {
      expect(() =>
        probeImageBuffer(
          Buffer.concat([
            Buffer.from([0xff, 0xd8]),
            jpegSegment(0xe0, Buffer.from("metadata")),
            Buffer.from([0xff, 0xd9]),
          ]),
          "missing-sof.jpg",
        ),
      ).toThrow(/헤더/);

      const badLength = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]),
        Buffer.alloc(8),
      ]);
      expect(() => probeImageBuffer(badLength, "bad-length.jpg")).toThrow(
        /헤더/,
      );

      const beyondFile = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]),
        Buffer.alloc(8),
      ]);
      expect(() => probeImageBuffer(beyondFile, "beyond.jpg")).toThrow(/헤더/);

      const truncatedSof = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00]),
        Buffer.alloc(4),
      ]);
      expect(() => probeImageBuffer(truncatedSof, "truncated-sof.jpg")).toThrow(
        /헤더/,
      );
    });

    it("caps the number of scanned markers", () => {
      const markers = Array.from({ length: 4097 }, () =>
        Buffer.from([0xff, 0x01]),
      );
      expect(() =>
        probeImageBuffer(
          Buffer.concat([
            Buffer.from([0xff, 0xd8]),
            ...markers,
            Buffer.from([0xff, 0xd9]),
          ]),
          "marker-bomb.jpg",
        ),
      ).toThrow(/헤더/);
    });

    it("rejects oversized SOF dimensions", () => {
      expect(() =>
        probeImageBuffer(
          makeJpeg({ width: 65_535, height: 65_535 }),
          "oversized.jpg",
        ),
      ).toThrow(/해상도가 너무 큽니다/);
    });
  });

  describe("WebP", () => {
    it("reads VP8X canvas dimensions", () => {
      expect(
        probeImageBuffer(makeVp8xWebp(1000, 2000), "page.webp"),
      ).toMatchObject({
        format: "webp",
        width: 1000,
        height: 2000,
      });
    });

    it("reads VP8L dimensions", () => {
      expect(
        probeImageBuffer(makeVp8lWebp(321, 654), "lossless.webp"),
      ).toMatchObject({ width: 321, height: 654 });
    });

    it("reads lossy VP8 dimensions", () => {
      expect(
        probeImageBuffer(makeVp8Webp(640, 480), "lossy.webp"),
      ).toMatchObject({ width: 640, height: 480 });
    });

    it("accepts animated frames inside the VP8X canvas", () => {
      expect(
        probeImageBuffer(
          makeAnimatedWebp({
            canvasWidth: 100,
            canvasHeight: 80,
            frameX: 10,
            frameY: 8,
            frameWidth: 50,
            frameHeight: 40,
          }),
          "animated.webp",
        ),
      ).toMatchObject({ width: 100, height: 80 });
    });

    it("rejects ANMF outside its canvas and oversized frames", () => {
      expect(() =>
        probeImageBuffer(
          makeAnimatedWebp({
            canvasWidth: 100,
            canvasHeight: 80,
            frameX: 60,
            frameY: 0,
            frameWidth: 50,
            frameHeight: 40,
          }),
          "outside.webp",
        ),
      ).toThrow(/헤더/);

      expect(() =>
        probeImageBuffer(
          makeAnimatedWebp({
            canvasWidth: 100_000,
            canvasHeight: 100_000,
            frameX: 0,
            frameY: 0,
            frameWidth: 20_000,
            frameHeight: 8_000,
          }),
          "oversized-frame.webp",
        ),
      ).toThrow(/해상도가 너무 큽니다/);
    });

    it("rejects RIFF and chunk bounds violations", () => {
      const beyond = makeVp8xWebp(1, 1);
      beyond.writeUInt32LE(beyond.readUInt32LE(4) + 100, 4);
      expect(() => probeImageBuffer(beyond, "riff-beyond.webp")).toThrow(
        /헤더/,
      );

      const truncated = makeVp8xWebp(1, 1).subarray(0, -1);
      expect(() => probeImageBuffer(truncated, "truncated.webp")).toThrow(
        /헤더/,
      );

      const unknown = makeWebp([webpChunk("JUNK", Buffer.alloc(2))]);
      expect(() => probeImageBuffer(unknown, "unknown.webp")).toThrow(/헤더/);
    });
  });

  describe("bounded file reader", () => {
    it("probes a file and closes its handle", async () => {
      const dir = await makeTempDir();
      const imagePath = join(dir, "page.png");
      await writeFile(imagePath, makePngHeader(77, 88));

      await expect(
        probeImageFile(imagePath, "page.png"),
      ).resolves.toMatchObject({
        width: 77,
        height: 88,
      });
      await expect(rm(imagePath)).resolves.toBeUndefined();
    });

    it("honors an already-aborted signal", async () => {
      const dir = await makeTempDir();
      const imagePath = join(dir, "page.png");
      await writeFile(imagePath, makePngHeader(1, 1));
      const controller = new AbortController();
      controller.abort();

      await expect(
        probeImageFile(imagePath, "page.png", undefined, controller.signal),
      ).rejects.toMatchObject({ name: "AbortError" });
    });
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "image-header-probe-"));
  tempDirs.push(dir);
  return dir;
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

function makeJpeg({
  width,
  height,
  sofMarker = 0xc0,
  orientation,
  appSegments = [],
  fillBeforeSof = 0,
}: {
  width: number;
  height: number;
  sofMarker?: number;
  orientation?: number;
  appSegments?: Buffer[];
  fillBeforeSof?: number;
}): Buffer {
  const pieces: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (orientation !== undefined) {
    pieces.push(jpegSegment(0xe1, makeExifPayload(orientation)));
  }
  for (const payload of appSegments) {
    pieces.push(jpegSegment(0xe0, payload));
  }
  const sofPayload = Buffer.alloc(9);
  sofPayload[0] = 8;
  sofPayload.writeUInt16BE(height, 1);
  sofPayload.writeUInt16BE(width, 3);
  sofPayload[5] = 1;
  sofPayload[6] = 1;
  sofPayload[7] = 0x11;
  sofPayload[8] = 0;
  pieces.push(
    Buffer.concat([
      Buffer.alloc(fillBeforeSof, 0xff),
      jpegSegment(sofMarker, sofPayload),
    ]),
    Buffer.from([0xff, 0xd9]),
  );
  return Buffer.concat(pieces);
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const segment = Buffer.alloc(4 + payload.length);
  segment[0] = 0xff;
  segment[1] = marker;
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return segment;
}

function makeExifPayload(orientation: number): Buffer {
  const payload = Buffer.alloc(6 + 8 + 2 + 12);
  payload.write("Exif\0\0", 0, "binary");
  const tiff = 6;
  payload.write("II", tiff, "ascii");
  payload.writeUInt16LE(42, tiff + 2);
  payload.writeUInt32LE(8, tiff + 4);
  const ifd = tiff + 8;
  payload.writeUInt16LE(1, ifd);
  const entry = ifd + 2;
  payload.writeUInt16LE(0x0112, entry);
  payload.writeUInt16LE(3, entry + 2);
  payload.writeUInt32LE(1, entry + 4);
  payload.writeUInt16LE(orientation, entry + 8);
  return payload;
}

function makeVp8xWebp(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10);
  writeUint24LE(payload, 4, width - 1);
  writeUint24LE(payload, 7, height - 1);
  return makeWebp([webpChunk("VP8X", payload)]);
}

function makeVp8lWebp(width: number, height: number): Buffer {
  const w = width - 1;
  const h = height - 1;
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  payload[1] = w & 0xff;
  payload[2] = ((w >> 8) & 0x3f) | ((h & 0x03) << 6);
  payload[3] = (h >> 2) & 0xff;
  payload[4] = (h >> 10) & 0x0f;
  return makeWebp([webpChunk("VP8L", payload)]);
}

function makeVp8Webp(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10);
  payload.set([0x9d, 0x01, 0x2a], 3);
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return makeWebp([webpChunk("VP8 ", payload)]);
}

function makeAnimatedWebp({
  canvasWidth,
  canvasHeight,
  frameX,
  frameY,
  frameWidth,
  frameHeight,
}: {
  canvasWidth: number;
  canvasHeight: number;
  frameX: number;
  frameY: number;
  frameWidth: number;
  frameHeight: number;
}): Buffer {
  const canvas = Buffer.alloc(10);
  writeUint24LE(canvas, 4, canvasWidth - 1);
  writeUint24LE(canvas, 7, canvasHeight - 1);
  const frame = Buffer.alloc(16);
  writeUint24LE(frame, 0, Math.floor(frameX / 2));
  writeUint24LE(frame, 3, Math.floor(frameY / 2));
  writeUint24LE(frame, 6, frameWidth - 1);
  writeUint24LE(frame, 9, frameHeight - 1);
  return makeWebp([webpChunk("VP8X", canvas), webpChunk("ANMF", frame)]);
}

function webpChunk(fourcc: string, payload: Buffer): Buffer {
  const padding = payload.length % 2;
  const chunk = Buffer.alloc(8 + payload.length + padding);
  chunk.write(fourcc, 0, "ascii");
  chunk.writeUInt32LE(payload.length, 4);
  payload.copy(chunk, 8);
  return chunk;
}

function makeWebp(chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + body.length, 4);
  header.write("WEBP", 8, "ascii");
  return Buffer.concat([header, body]);
}

function writeUint24LE(buffer: Buffer, offset: number, value: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
  buffer[offset + 2] = (value >> 16) & 0xff;
}
