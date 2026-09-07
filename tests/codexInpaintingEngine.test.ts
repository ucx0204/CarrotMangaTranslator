import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import {
  createCodexInpaintingEngine,
  acquireCodexInpaintingEngine,
} from "../src/main/inpainting/codexInpaintingEngine";
import { CodexAppServerClient } from "../src/main/codexAppServerClient";
import type { AppPaths } from "../src/main/appPaths";
import { resolveDefaultAppSettings } from "../src/main/settings/appSettingsDefaults";
import { withApprovedImageRedactions } from "../src/main/imageRedactionContext";

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
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

it.each([undefined, "max"] as const)(
  "routes image effort independently of text effort (%s)",
  async (imageEffort) => {
    const fixture = await setup();
    const dispose = vi.fn(async () => {});
    // App Server is the external image-generation boundary; raster composition remains real.
    const connection: Pick<
      CodexAppServerClient,
      "readAccount" | "listModels" | "runEphemeralTurn" | "dispose"
    > = {
      readAccount: async () => ({
        account: { type: "chatgpt", email: null, planType: "plus" },
        requiresOpenaiAuth: true,
      }),
      listModels: async () => [
        {
          id: "gpt-6-astra",
          displayName: "GPT-6-Astra",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: ["low", "high", "max"],
        },
      ],
      runEphemeralTurn: fixture.turn,
      dispose,
    };
    const start = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValue(connection as CodexAppServerClient);
    const settings = resolveDefaultAppSettings({});
    settings.codex = {
      ...settings.codex,
      model: "gpt-6-astra",
      reasoningEffort: "high",
      imageReasoningEffort: imageEffort,
    };
    const signal = new AbortController().signal;
    const lease = await acquireCodexInpaintingEngine(
      { dataRoot: fixture.directory } as AppPaths,
      settings,
      signal,
    );
    await lease.engine.inpaint(
      fixture.bitmap,
      192,
      160,
      fixture.mask,
      [fixture.window],
      { featherPx: 8 },
    );
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "image-generation", signal }),
    );
    expect(fixture.turn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-6-astra",
        effort: imageEffort ?? "low",
      }),
    );
    expect(fixture.bitmap[(75 * 192 + 85) * 4]).toBe(255);
    await lease.release();
    expect(dispose).toHaveBeenCalledOnce();
  },
);

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
    directory,
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

it.each(["paint", "region"] as const)(
  "redacts %s references while restoring hidden original pixels locally",
  async (mode) => {
    const fixture = await setup();
    const imagePath = join(fixture.directory, "source.png");
    const hiddenPixel = (40 * 192 + 40) * 4;
    fixture.bitmap.fill(42, hiddenPixel, hiddenPixel + 3);
    await withApprovedImageRedactions(
      [
        {
          id: "page",
          name: "source.png",
          imagePath,
          width: 192,
          height: 160,
          fingerprint: "a".repeat(64),
          strokes: [{ shape: "square", size: 4, points: [{ x: 40, y: 40 }] }],
        },
      ],
      () =>
        fixture.engine.inpaint(
          fixture.bitmap,
          192,
          160,
          fixture.mask,
          [fixture.window],
          {
            sourceImagePath: imagePath,
            codexMaskMode: mode,
          },
        ),
    );
    expect(fixture.turn).toHaveBeenCalledOnce();
    const references = fixture.turn.mock.calls[0][0].input.filter(
      (item) => item.type === "image",
    );
    for (const index of mode === "paint" ? [0, 2] : [0]) {
      const png = PNG.sync.read(
        Buffer.from(references[index].url.split(",")[1], "base64"),
      );
      const offset = ((40 - 12) * png.width + 40 - 27) * 4;
      expect([...png.data.subarray(offset, offset + 4)]).toEqual([
        255, 255, 255, 255,
      ]);
    }
    expect(fixture.bitmap[hiddenPixel]).toBe(42);
    expect(fixture.bitmap[(75 * 192 + 85) * 4]).toBe(255);
  },
);

it("rejects a painted feather overlap with redaction before sending any image", async () => {
  const fixture = await setup();
  const imagePath = join(fixture.directory, "source.png");
  await expect(
    withApprovedImageRedactions(
      [
        {
          id: "page",
          name: "source.png",
          imagePath,
          width: 192,
          height: 160,
          fingerprint: "a".repeat(64),
          strokes: [{ shape: "square", size: 2, points: [{ x: 70, y: 70 }] }],
        },
      ],
      () =>
        fixture.engine.inpaint(
          fixture.bitmap,
          192,
          160,
          fixture.mask,
          [fixture.window],
          {
            sourceImagePath: imagePath,
            featherPx: 8,
          },
        ),
    ),
  ).rejects.toThrow("가리기와 겹치는");
  expect(fixture.turn).not.toHaveBeenCalled();
  expect(fixture.bitmap).toEqual(fixture.before);
});

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
