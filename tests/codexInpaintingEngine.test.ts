import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { createCodexInpaintingEngine } from "../src/main/inpainting/codexInpaintingEngine";
import type { CodexAppServerClient } from "../src/main/codexAppServerClient";

vi.mock("electron", () => ({
  app: { getVersion: () => "fixture" },
  nativeImage: {
    createFromBitmap: (data: Buffer, size: { width: number; height: number }) =>
      new Raster(data, size.width, size.height),
    createFromBuffer: (bytes: Buffer) => {
      const png = PNG.sync.read(bytes);
      return new Raster(png.data, png.width, png.height);
    },
  },
}));
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

it("generates one expanded crop and preserves pixels beyond the owned core and feather", async () => {
  const fixture = await setup();
  await fixture.engine.inpaint(
    fixture.bitmap,
    192,
    160,
    fixture.mask,
    [fixture.window],
    { featherPx: 8 },
  );
  expect(fixture.turn).toHaveBeenCalledOnce();
  expect(fixture.bitmap[(75 * 192 + 85) * 4]).toBe(255);
  for (let y = 0; y < 160; y++)
    for (let x = 0; x < 192; x++) {
      if (x >= 67 && x < 108 && y >= 52 && y < 98) continue;
      const offset = (y * 192 + x) * 4;
      expect(fixture.bitmap.subarray(offset, offset + 4)).toEqual(
        fixture.before.subarray(offset, offset + 4),
      );
    }
});

it("keeps a protected mask hole intact and never retries an invalid generated result", async () => {
  const fixture = await setup();
  const protectedAt = 75 * 192 + 85;
  const constraint = new Uint8Array(25 * 30).fill(1);
  constraint[(75 - 60) * 25 + 85 - 75] = 0;
  await fixture.engine.inpaint(
    fixture.bitmap,
    192,
    160,
    fixture.mask,
    [fixture.window],
    {
      featherPx: 0,
      compositeConstraints: [{ bounds: fixture.window, data: constraint }],
    },
  );
  expect(fixture.bitmap[protectedAt * 4]).toBe(fixture.before[protectedAt * 4]);
  fixture.turn.mockRejectedValue(new Error("image unavailable"));
  const beforeFailure = Buffer.from(fixture.bitmap);
  await expect(
    fixture.engine.inpaint(fixture.bitmap, 192, 160, fixture.mask, [
      fixture.window,
    ]),
  ).rejects.toThrow("image unavailable");
  expect(fixture.turn).toHaveBeenCalledTimes(2);
  expect(fixture.bitmap).toEqual(beforeFailure);
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "codex-inpaint-"));
  dirs.push(directory);
  const bitmap = Buffer.alloc(192 * 160 * 4, 255);
  const mask = new Uint8Array(192 * 160);
  const window = { x: 75, y: 60, w: 25, h: 30 };
  for (let y = 0; y < 160; y++)
    for (let x = 0; x < 192; x++) {
      const owned = x >= 75 && x < 100 && y >= 60 && y < 90;
      const value = owned ? 0 : x % 19 === 0 || y % 23 === 0 ? 96 : 255;
      bitmap.fill(value, (y * 192 + x) * 4, (y * 192 + x) * 4 + 3);
      if (owned) mask[y * 192 + x] = 1;
    }
  const turn = vi.fn<CodexAppServerClient["runEphemeralTurn"]>(
    async (request) => {
      const images = request.input.filter((item) => item.type === "image");
      const source = PNG.sync.read(
        Buffer.from(images[0].url.split(",")[1], "base64"),
      );
      const permission = PNG.sync.read(
        Buffer.from(images[1].url.split(",")[1], "base64"),
      );
      expect(source.width).toBe(121);
      expect(source.height).toBe(126);
      for (let i = 0; i < source.width * source.height; i++)
        if (permission.data[i * 4]) source.data.fill(255, i * 4, i * 4 + 4);
      return {
        threadId: "fixture",
        itemId: "fixture",
        turnId: "fixture",
        text: JSON.stringify({
          result: PNG.sync.write(source).toString("base64"),
        }),
      };
    },
  );
  return {
    bitmap,
    mask,
    window,
    before: Buffer.from(bitmap),
    turn,
    engine: createCodexInpaintingEngine(
      { runEphemeralTurn: turn },
      directory,
      new AbortController().signal,
      async () => {},
    ),
  };
}

/** Native-image boundary double; the real Electron decoder is also exercised by the local smoke. */
class Raster {
  constructor(
    readonly data: Buffer,
    readonly width: number,
    readonly height: number,
  ) {}
  isEmpty() {
    return false;
  }
  toBitmap() {
    return Buffer.from(this.data);
  }
  toPNG() {
    const png = new PNG({ width: this.width, height: this.height });
    png.data = this.data;
    return PNG.sync.write(png);
  }
  toDataURL() {
    return `data:image/png;base64,${this.toPNG().toString("base64")}`;
  }
  resize(size: { width: number; height: number }) {
    expect(size.width).toBe(this.width);
    expect(size.height).toBe(this.height);
    return this;
  }
  crop(rect: { x: number; y: number; width: number; height: number }) {
    expect(rect.x + rect.width).toBeLessThanOrEqual(this.width);
    expect(rect.y + rect.height).toBeLessThanOrEqual(this.height);
    const data = Buffer.alloc(rect.width * rect.height * 4);
    for (let y = 0; y < rect.height; y++) {
      const start = ((y + rect.y) * this.width + rect.x) * 4;
      this.data.copy(data, y * rect.width * 4, start, start + rect.width * 4);
    }
    return new Raster(data, rect.width, rect.height);
  }
}
