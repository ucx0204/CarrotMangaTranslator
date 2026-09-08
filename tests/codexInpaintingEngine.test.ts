import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
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
import {
  withApprovedImageRedactions,
  imageFingerprint,
} from "../src/main/imageRedactionContext";

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
it.each(["complete", "cancel", "invalid"])(
  "uses original page context for a thin selection without changing its coordinates (%s)",
  async (outcome) => {
    const directory = await mkdtemp(join(tmpdir(), "codex-context-"));
    dirs.push(directory);
    const full = new Raster(Buffer.alloc(300 * 300 * 4, 255), 300, 300),
      crop = { x: 20, y: 120, w: 260, h: 40 };
    const bitmap = Buffer.alloc(260 * 40 * 4, 255),
      mask = new Uint8Array(260 * 40),
      keep = new Uint8Array(mask.length);
    for (let y = 10; y < 30; y++)
      for (let x = 40; x < 220; x++) {
        mask[y * 260 + x] = 1;
        bitmap.fill(0, (y * 260 + x) * 4, (y * 260 + x) * 4 + 3);
      }
    keep[20 * 260 + 100] = 255;
    const original = Buffer.from(bitmap),
      sourcePath = join(directory, "page.png");
    await writeFile(sourcePath, full.toPNG());
    const controller = new AbortController();
    const turn = vi.fn<CodexAppServerClient["runEphemeralTurn"]>(
      async (request) => {
        if (outcome === "cancel") controller.abort();
        const images = request.input.filter((item) => item.type === "image");
        const source = PNG.sync.read(
          Buffer.from(images[0].url.split(",")[1], "base64"),
        );
        const permission = PNG.sync.read(
          Buffer.from(images[1].url.split(",")[1], "base64"),
        );
        const prompt = request.input.find((item) => item.type === "text");
        expect(prompt?.text).toContain(
          '"bounds":{"x":60,"y":101,"w":180,"h":20}',
        );
        expect(prompt?.text).toContain("small linked text");
        expect(prompt?.text).toContain("filled surface");
        expect(prompt?.text).not.toContain("off-crop text");
        expect(images).toHaveLength(2);
        expect(source.height).toBeGreaterThan(crop.h);
        for (let p = 0; p < source.width * source.height; p++)
          if (permission.data[p * 4]) source.data.fill(255, p * 4, p * 4 + 4);
        return {
          threadId: "native",
          turnId: "native",
          itemId: "native",
          text: JSON.stringify({
            result: PNG.sync.write(source).toString("base64"),
          }),
        };
      },
    );
    const context = {
      sourcePage: {
        id: "p",
        name: "p",
        imagePath: sourcePath,
        dataUrl: "",
        width: 300,
        height: 300,
        blocks: [],
        analysisStatus: "idle" as const,
        createdAt: "",
        updatedAt: "",
      },
      cropRect: outcome === "invalid" ? { ...crop, x: 80 } : crop,
    };
    const engine = createCodexInpaintingEngine(
      { runEphemeralTurn: turn },
      directory,
      controller.signal,
      async () => {},
      keep,
      context,
      [
        {
          sourceText: "small linked text",
          appearance: "fine strokes on a filled surface",
          bounds: { x: 40, y: 10, w: 180, h: 20 },
        },
        {
          sourceText: "off-crop text",
          bounds: { x: 900, y: 900, w: 10, h: 10 },
        },
      ],
    );
    const operation = engine.inpaint(
      bitmap,
      260,
      40,
      mask,
      [{ x: 0, y: 0, w: 260, h: 40 }],
      { codexMaskMode: "region", featherPx: 0, signal: controller.signal },
    );
    if (outcome === "complete") {
      await operation;
      expect(turn).toHaveBeenCalledOnce();
      expect(bitmap[(20 * 260 + 80) * 4]).toBe(255);
      expect(bitmap[(20 * 260 + 100) * 4]).toBe(0);
    } else {
      await expect(operation).rejects.toThrow();
      expect(bitmap).toEqual(original);
      expect(turn).toHaveBeenCalledTimes(outcome === "cancel" ? 1 : 0);
    }
  },
);
it.each(["complete", "cancel", "failure"])(
  "handles a wide painted selection atomically (%s), with one call per planned tile",
  async (outcome) => {
    const directory = await mkdtemp(join(tmpdir(), "codex-wide-"));
    dirs.push(directory);
    const width = 987,
      height = 240;
    const bitmap = Buffer.alloc(width * height * 4, 255);
    const mask = new Uint8Array(width * height);
    for (let y = 80; y < 160; y++)
      for (let x = 20; x < 967; x++) {
        mask[y * width + x] = 1;
        bitmap.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
      }
    const before = Buffer.from(bitmap),
      controller = new AbortController();
    let calls = 0;
    const turn: CodexAppServerClient["runEphemeralTurn"] = async (request) => {
      calls++;
      if (calls === 2 && outcome === "failure")
        throw new Error("provider failed");
      if (calls === 1 && outcome === "cancel") controller.abort();
      const images = request.input.filter((item) => item.type === "image");
      const crop = PNG.sync.read(
        Buffer.from(images[0].url.split(",")[1], "base64"),
      );
      const permission = PNG.sync.read(
        Buffer.from(images[1].url.split(",")[1], "base64"),
      );
      expect(
        Math.max(crop.width, crop.height) / Math.min(crop.width, crop.height),
      ).toBeLessThanOrEqual(3);
      for (let at = 0; at < crop.width * crop.height; at++)
        if (permission.data[at * 4]) crop.data.fill(255, at * 4, at * 4 + 4);
      return {
        threadId: "fixture",
        turnId: String(calls),
        itemId: String(calls),
        text: JSON.stringify({
          result: PNG.sync.write(crop).toString("base64"),
        }),
      };
    };
    const engine = createCodexInpaintingEngine(
      { runEphemeralTurn: turn },
      directory,
      controller.signal,
      async () => {},
    );
    const work = engine.inpaint(
      bitmap,
      width,
      height,
      mask,
      [{ x: 20, y: 80, w: 947, h: 80 }],
      { featherPx: 0 },
    );
    if (outcome === "complete") {
      await work;
      expect(calls).toBe(3);
      expect(bitmap.every((value) => value === 255)).toBe(true);
      expect(
        (await readdir(directory)).filter((name) =>
          name.startsWith("permission-"),
        ),
      ).toHaveLength(3);
    } else {
      await expect(work).rejects.toThrow();
      expect(bitmap).toEqual(before);
      expect(calls).toBe(outcome === "cancel" ? 1 : 2);
    }
  },
);
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

it("protects reviewed exclusions across owned windows and feathered pixels", async () => {
  const fixture = await setup();
  const protection = new Uint8Array(192 * 160);
  for (let y = 70; y < 80; y++)
    for (let x = 82; x < 90; x++) protection[y * 192 + x] = 255;
  const engine = createCodexInpaintingEngine(
    { runEphemeralTurn: fixture.turn },
    fixture.directory,
    new AbortController().signal,
    async () => {},
    protection,
  );
  await engine.inpaint(
    fixture.bitmap,
    192,
    160,
    fixture.mask,
    [fixture.window],
    {
      codexMaskMode: "region",
      featherPx: 8,
      windowMasks: [
        { bounds: fixture.window, data: new Uint8Array(25 * 30).fill(1) },
      ],
    },
  );
  expect(fixture.turn).toHaveBeenCalledOnce();
  expect(fixture.bitmap).not.toEqual(fixture.before);
  for (let pixel = 0; pixel < protection.length; pixel++)
    if (protection[pixel])
      expect(fixture.bitmap.subarray(pixel * 4, pixel * 4 + 4)).toEqual(
        fixture.before.subarray(pixel * 4, pixel * 4 + 4),
      );
});

it.each(["paint", "region"] as const)(
  "redacts %s references while restoring hidden original pixels locally",
  async (mode) => {
    const fixture = await setup();
    const imagePath = join(fixture.directory, "source.png");
    const hiddenPixel = (40 * 192 + 40) * 4;
    fixture.bitmap.fill(42, hiddenPixel, hiddenPixel + 3);
    await writeFile(imagePath, new Raster(fixture.bitmap, 192, 160).toPNG());
    await withApprovedImageRedactions(
      [
        {
          id: "page",
          name: "source.png",
          imagePath,
          width: 192,
          height: 160,
          fingerprint: await imageFingerprint(imagePath),
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
  await writeFile(imagePath, new Raster(fixture.bitmap, 192, 160).toPNG());
  await expect(
    withApprovedImageRedactions(
      [
        {
          id: "page",
          name: "source.png",
          imagePath,
          width: 192,
          height: 160,
          fingerprint: await imageFingerprint(imagePath),
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
  getSize() {
    return { width: this.width, height: this.height };
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

it.each([false, true, "partial-change"] as const)(
  "distinguishes unchanged output from mismatched framing (%s)",
  async (mismatched) => {
    const fixture = await setup();
    fixture.turn.mockImplementationOnce(async (request) => {
      const image = request.input.find((item) => item.type === "image");
      if (!image || image.type !== "image") throw Error("Missing source");
      const candidate = PNG.sync.read(
        Buffer.from(image.url.split(",")[1], "base64"),
      );
      if (mismatched)
        for (let i = 0; i < candidate.width * candidate.height; i++) {
          const value = ((i * 1103515245 + 12345) >>> 8) % 256;
          candidate.data.fill(value, i * 4, i * 4 + 3);
        }
      if (mismatched === "partial-change") {
        const maskImage = request.input.filter(
          (item) => item.type === "image",
        )[1];
        const permission = PNG.sync.read(
          Buffer.from(maskImage.url.split(",")[1], "base64"),
        );
        for (let at = 0; at < candidate.width * candidate.height; at++)
          candidate.data.fill(
            permission.data[at * 4] ? 255 : 128,
            at * 4,
            at * 4 + 3,
          );
      }
      return {
        threadId: "test",
        itemId: "test",
        turnId: "test",
        text: JSON.stringify({
          result: PNG.sync.write(candidate).toString("base64"),
        }),
      };
    });
    const operation = fixture.engine.inpaint(
      fixture.bitmap,
      192,
      160,
      fixture.mask,
      [fixture.window],
      { codexMaskMode: "region" },
    );
    if (mismatched) await expect(operation).rejects.toThrow("구도·경계");
    else await expect(operation).resolves.toBeUndefined();
    if (mismatched === "partial-change") {
      const file = (await readdir(fixture.directory)).find((name) =>
        name.startsWith("splice-"),
      );
      if (!file) throw Error("Missing splice diagnostics");
      const audit = JSON.parse(
        await readFile(join(fixture.directory, file), "utf8"),
      );
      expect(audit.changedPixels).toBeGreaterThan(0);
    }
    expect(fixture.turn).toHaveBeenCalledOnce();
    expect(fixture.bitmap).toEqual(fixture.before);
  },
);

it.each([false, true])(
  "blocks unreviewed source pixels even after restoring approved file bytes (%s)",
  async (restored) => {
    const fixture = await setup();
    const imagePath = join(fixture.directory, "source.png");
    const original = new Raster(fixture.bitmap, 192, 160).toPNG();
    await writeFile(imagePath, original);
    const fingerprint = await imageFingerprint(imagePath);
    fixture.bitmap.fill(12, (45 * 192 + 45) * 4, (45 * 192 + 45) * 4 + 3);
    await writeFile(imagePath, new Raster(fixture.bitmap, 192, 160).toPNG());
    if (restored) await writeFile(imagePath, original);
    const changed = Buffer.from(fixture.bitmap);
    await expect(
      withApprovedImageRedactions(
        [
          {
            id: "page",
            name: "source.png",
            imagePath,
            width: 192,
            height: 160,
            fingerprint,
            strokes: [],
          },
        ],
        () =>
          fixture.engine.inpaint(
            fixture.bitmap,
            192,
            160,
            fixture.mask,
            [fixture.window],
            { sourceImagePath: imagePath },
          ),
      ),
    ).rejects.toThrow();
    expect(fixture.turn).not.toHaveBeenCalled();
    expect(fixture.bitmap).toEqual(changed);
  },
);
it("preserves derived image pixels while verifying their reviewed original", async () => {
  const fixture = await setup();
  const imagePath = join(fixture.directory, "source.png");
  await writeFile(imagePath, new Raster(fixture.bitmap, 192, 160).toPNG());
  const fingerprint = await imageFingerprint(imagePath);
  const at = (45 * 192 + 45) * 4;
  fixture.bitmap.fill(57, at, at + 3);
  const inputImagePath = join(fixture.directory, "already-inpainted.png");
  await writeFile(inputImagePath, new Raster(fixture.bitmap, 192, 160).toPNG());
  await withApprovedImageRedactions(
    [
      {
        id: "page",
        name: "source.png",
        imagePath,
        width: 192,
        height: 160,
        fingerprint,
        strokes: [],
      },
    ],
    () =>
      fixture.engine.inpaint(
        fixture.bitmap,
        192,
        160,
        fixture.mask,
        [fixture.window],
        { sourceImagePath: imagePath, inputImagePath },
      ),
  );
  expect(fixture.turn).toHaveBeenCalledOnce();
  expect(fixture.bitmap[at]).toBe(57);
  const reference = fixture.turn.mock.calls[0][0].input.find(
    (item) => item.type === "image",
  );
  if (!reference || reference.type !== "image")
    throw Error("Missing reference");
  const png = PNG.sync.read(Buffer.from(reference.url.split(",")[1], "base64"));
  expect(png.data[((45 - 12) * png.width + 45 - 27) * 4]).toBe(57);
});
it("sends the captured bitmap when caller storage changes during asynchronous validation", async () => {
  const fixture = await setup();
  const imagePath = join(fixture.directory, "source.png");
  await writeFile(imagePath, new Raster(fixture.bitmap, 192, 160).toPNG());
  const fingerprint = await imageFingerprint(imagePath);
  const at = (45 * 192 + 45) * 4;
  await withApprovedImageRedactions(
    [
      {
        id: "page",
        name: "source.png",
        imagePath,
        width: 192,
        height: 160,
        fingerprint,
        strokes: [],
      },
    ],
    async () => {
      const operation = fixture.engine.inpaint(
        fixture.bitmap,
        192,
        160,
        fixture.mask,
        [fixture.window],
        { sourceImagePath: imagePath },
      );
      fixture.bitmap.fill(3, at, at + 3);
      await operation;
    },
  );
  const image = fixture.turn.mock.calls[0][0].input.find(
    (item) => item.type === "image",
  );
  if (!image || image.type !== "image") throw Error("Missing reference");
  const png = PNG.sync.read(Buffer.from(image.url.split(",")[1], "base64"));
  expect(png.data[((45 - 12) * png.width + 45 - 27) * 4]).toBe(
    fixture.before[at],
  );
});
