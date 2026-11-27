export function createCopyWorkerScript(capturePath?: string): string {
  return `
const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "shutdown") {
    process.exit(0);
  }
  ${
    capturePath
      ? `
  const maskFile = fs.readFileSync(request.mask);
  const newline = maskFile.indexOf(10);
  const maskBitmap = maskFile.subarray(newline + 1);
  let activeMaskPixels = 0;
  for (let offset = 0; offset < maskBitmap.length; offset += 4) {
    if (maskBitmap[offset] > 0) activeMaskPixels += 1;
  }
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
    maskPadding: request.mask_padding,
    activeMaskPixels,
  }));
  `
      : ""
  }
  fs.copyFileSync(request.input, request.output);
  process.stdout.write(JSON.stringify({ id: request.id, ok: true }) + "\\n");
});
`;
}

export function createTileCaptureWorkerScript(capturePath: string): string {
  return `
const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "shutdown") {
    process.exit(0);
  }
  const input = fs.readFileSync(request.input);
  const newline = input.indexOf(10);
  const header = JSON.parse(input.subarray(0, newline).toString("utf8"));
  const requests = fs.existsSync(${JSON.stringify(capturePath)})
    ? JSON.parse(fs.readFileSync(${JSON.stringify(capturePath)}, "utf8"))
    : [];
  requests.push({
    width: header.width,
    height: header.height,
    maxPixels: request.max_pixels,
    steps: request.steps,
  });
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(requests));
  fs.copyFileSync(request.input, request.output);
  process.stdout.write(JSON.stringify({ id: request.id, ok: true }) + "\\n");
});
`;
}

export function createMaskCaptureWorkerScript(capturePath: string): string {
  return `
const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "shutdown") {
    process.exit(0);
  }
  const inputFile = fs.readFileSync(request.input);
  const inputNewline = inputFile.indexOf(10);
  const inputHeader = JSON.parse(inputFile.subarray(0, inputNewline).toString("utf8"));
  const inputBitmap = inputFile.subarray(inputNewline + 1);
  const originX = inputBitmap[0];
  const originY = inputBitmap[1];
  const maskFile = fs.readFileSync(request.mask);
  const newline = maskFile.indexOf(10);
  const maskBitmap = maskFile.subarray(newline + 1);
  const activePixels = [];
  for (let offset = 0; offset < maskBitmap.length; offset += 4) {
    if (maskBitmap[offset] === 0) continue;
    const pixel = offset / 4;
    activePixels.push(
      String(originX + (pixel % inputHeader.width)) + "," +
      String(originY + Math.floor(pixel / inputHeader.width)),
    );
  }
  const requests = fs.existsSync(${JSON.stringify(capturePath)})
    ? JSON.parse(fs.readFileSync(${JSON.stringify(capturePath)}, "utf8"))
    : [];
  requests.push({ activePixels, speechBubble: request.speech_bubble,
    inputHash: require("node:crypto").createHash("sha256").update(inputFile).digest("hex") });
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(requests));
  fs.copyFileSync(request.input, request.output);
  process.stdout.write(JSON.stringify({ id: request.id, ok: true }) + "\\n");
});
`;
}

export function createMaskChangingWorkerScript(capturePath: string): string {
  return `
const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "shutdown") {
    process.exit(0);
  }
  const inputFile = fs.readFileSync(request.input);
  const inputNewline = inputFile.indexOf(10);
  const inputBitmap = Buffer.from(inputFile.subarray(inputNewline + 1));
  const maskFile = fs.readFileSync(request.mask);
  const maskNewline = maskFile.indexOf(10);
  const maskBitmap = maskFile.subarray(maskNewline + 1);
  for (let offset = 0; offset < maskBitmap.length; offset += 4) {
    if (maskBitmap[offset] === 0) continue;
    inputBitmap[offset] = 0;
    inputBitmap[offset + 1] = 0;
    inputBitmap[offset + 2] = 0;
  }
  fs.writeFileSync(
    request.output,
    Buffer.concat([inputFile.subarray(0, inputNewline + 1), inputBitmap]),
  );
  const requestCount = fs.existsSync(${JSON.stringify(capturePath)})
    ? Number(fs.readFileSync(${JSON.stringify(capturePath)}, "utf8"))
    : 0;
  fs.writeFileSync(${JSON.stringify(capturePath)}, String(requestCount + 1));
  process.stdout.write(JSON.stringify({ id: request.id, ok: true }) + "\\n");
});
`;
}

export function createCoordinateBitmap(width: number, height: number): Buffer {
  const bitmap = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      bitmap[offset] = x;
      bitmap[offset + 1] = y;
      bitmap[offset + 2] = 180;
      bitmap[offset + 3] = 255;
    }
  }
  return bitmap;
}

export function createFakeNativeImage(): {
  createFromBitmap: (
    bitmap: Buffer,
    size: { width: number; height: number },
  ) => FakeImage;
  createFromBuffer: (buffer: Buffer) => FakeImage;
  createFromPath: () => FakeImage;
} {
  return {
    createFromBitmap: (bitmap, size) =>
      new FakeImage(Buffer.from(bitmap), size.width, size.height),
    createFromBuffer: (buffer) => FakeImage.fromBuffer(buffer),
    createFromPath: () => FakeImage.empty(),
  };
}

class FakeImage {
  static empty(): FakeImage {
    return new FakeImage(Buffer.alloc(0), 0, 0, true);
  }

  static fromBuffer(buffer: Buffer): FakeImage {
    const newline = buffer.indexOf(10);
    if (newline < 0) {
      return FakeImage.empty();
    }
    const header = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as {
      width: number;
      height: number;
    };
    return new FakeImage(
      Buffer.from(buffer.subarray(newline + 1)),
      header.width,
      header.height,
    );
  }

  constructor(
    private readonly bitmap: Buffer,
    private readonly width: number,
    private readonly height: number,
    private readonly empty = false,
  ) {}

  isEmpty(): boolean {
    return this.empty;
  }

  resize(size: { width: number; height: number }): FakeImage {
    if (size.width === this.width && size.height === this.height) {
      return this;
    }
    return new FakeImage(
      Buffer.alloc(size.width * size.height * 4, 0),
      size.width,
      size.height,
      this.empty,
    );
  }

  getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  toBitmap(): Buffer {
    return Buffer.from(this.bitmap);
  }

  toPNG(): Buffer {
    const header = Buffer.from(
      `${JSON.stringify({ width: this.width, height: this.height })}\n`,
      "utf8",
    );
    return Buffer.concat([header, this.bitmap]);
  }
}
