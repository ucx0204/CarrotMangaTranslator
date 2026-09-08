import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import {
  CodexLetteringGenerationError,
  generateLetteringLayers,
} from "../src/main/pipeline/codexTypesettingLettering";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import type { CodexPageReading } from "../src/shared/codexTypesettingTypes";
import type { TypesettingLetteringContext } from "../src/main/application/codexTypesettingContracts";
import { serializeRichTextRuns } from "../src/shared/richTextMarkup";
import type { CodexAppServerClient } from "../src/main/codexAppServerClient";

const sourceImage = vi.hoisted(() => ({ open: vi.fn(), crop: vi.fn() }));
vi.mock("node:fs/promises", () => ({ writeFile: vi.fn(), readFile: vi.fn() }));
vi.mock("electron", () => ({
  nativeImage: {
    createFromPath: sourceImage.open,
    createFromBuffer: (bytes: Buffer) =>
      bytes.toString() === "source-fixture"
        ? sourceImage.open(bytes)
        : rasterImage(bytes),
  },
}));

function rasterImage(bytes: Buffer) {
  return {
    isEmpty: () => false,
    toPNG: () => bytes,
    toDataURL: () => `data:image/png;base64,${bytes.toString("base64")}`,
    crop: (rect: { x: number; y: number; width: number; height: number }) => {
      const source = PNG.sync.read(bytes);
      const crop = new PNG({ width: rect.width, height: rect.height });
      PNG.bitblt(source, crop, rect.x, rect.y, rect.width, rect.height, 0, 0);
      return rasterImage(PNG.sync.write(crop));
    },
  };
}

const bounds = { x: 100, y: 100, w: 100, h: 100 };
const block: TranslationBlock = {
  id: "r",
  type: "nonsolid",
  bbox: bounds,
  renderBbox: bounds,
  sourceText: "ドン",
  translatedText: "쾅",
  confidence: 1,
  sourceDirection: "horizontal",
  renderDirection: "horizontal",
  fontSizePx: 40,
  lineHeight: 1.2,
  textAlign: "center",
  textColor: "#000000",
  backgroundColor: "#ffffff",
  opacity: 0,
  fontFamily: "custom-font",
  bold: true,
};
const page: MangaPage = {
  id: "p",
  name: "p.png",
  imagePath: "original.png",
  dataUrl: "",
  width: 1000,
  height: 1500,
  blocks: [block],
  analysisStatus: "idle",
  createdAt: "",
  updatedAt: "",
};
const reading: CodexPageReading = {
  summary: "",
  regions: [
    {
      id: "r",
      action: "image",
      sourceText: block.sourceText,
      translatedText: block.translatedText,
      sourceBbox: bounds,
      renderBbox: bounds,
      role: "sound",
      direction: "horizontal",
      background: "artwork",
      reason: "display",
    },
  ],
};
const plan: TypesettingLetteringContext["plan"] = {
  groups: [
    {
      id: "f",
      description: "brush",
      members: [{ regionId: "r", bold: true, italic: false }],
    },
  ],
  fonts: [{ groupId: "f", fontId: "custom-font" }],
};
function imageBytes(opaque = false) {
  const image = new PNG({ width: 2, height: 2 });
  image.data[3] = 255;
  if (opaque) image.data.fill(255);
  return PNG.sync.write(image);
}

it("runs independent families concurrently and uses the first completed family member as a fixed style reference", async () => {
  const { context } = fixture();
  const blocks = ["one", "two", "other"].map((id, i) => ({
    ...block,
    id,
    translatedText: `target${i}`,
  }));
  const regions = blocks.map((b) => ({
    ...reading.regions[0],
    id: b.id,
    translatedText: b.translatedText,
  }));
  let release!: () => void;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  const turn = vi.fn<CodexAppServerClient["runEphemeralTurn"]>(
    async (request) => {
      const text =
        request.input.find((item) => item.type === "text")?.text ?? "";
      if (text.includes('Render exactly "target0"')) await first;
      return {
        threadId: "thread",
        turnId: "turn",
        itemId: "image",
        text: JSON.stringify({ result: imageBytes().toString("base64") }),
      };
    },
  );
  const pending = generateLetteringLayers(
    { ...page, blocks },
    { ...reading, regions },
    (id) => id,
    { runEphemeralTurn: turn },
    "run",
    new AbortController().signal,
    {
      ...context,
      previousPage: undefined,
      plan: {
        fonts: [],
        groups: [
          {
            id: "same",
            description: "shared",
            members: [
              { regionId: "one", bold: false, italic: false },
              { regionId: "two", bold: false, italic: false },
            ],
          },
        ],
      },
    },
  );
  await vi.waitFor(() => expect(turn).toHaveBeenCalledTimes(2));
  expect(
    turn.mock.calls.some(([r]) =>
      r.input.some(
        (i) => i.type === "text" && i.text.includes('Render exactly "target1"'),
      ),
    ),
  ).toBe(false);
  release();
  const result = await pending;
  expect(result.page.blocks.every((b) => b.generatedLettering)).toBe(true);
  const second = turn.mock.calls.find(([r]) =>
    r.input.some(
      (i) => i.type === "text" && i.text.includes('Render exactly "target1"'),
    ),
  )?.[0];
  const images = second?.input.filter((i) => i.type === "image");
  expect(images).toHaveLength(2);
  expect(images?.[1].url).toBe(
    result.page.blocks[0].generatedLettering?.dataUrl,
  );
  expect(turn).toHaveBeenCalledTimes(3);
});
function fixture() {
  const dataUrl = `data:image/png;base64,${imageBytes().toString("base64")}`;
  const previous = {
    ...block,
    generatedLettering: {
      version: 1 as const,
      dataUrl,
      translatedText: block.translatedText,
      sourceText: block.sourceText,
    },
  };
  const client = {
    runEphemeralTurn: vi.fn().mockResolvedValue({
      text: JSON.stringify({ result: dataUrl }),
      threadId: "thread",
      turnId: "turn",
      itemId: "image",
      routedModel: "gpt-6-astra",
    }),
  };
  const context: TypesettingLetteringContext = {
    attempt: 1,
    issues: [],
    plan,
    previousPage: { ...page, blocks: [previous] },
  };
  return { client, context, previous };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readFile).mockResolvedValue(Buffer.from("source-fixture"));
  sourceImage.open.mockReturnValue({ crop: sourceImage.crop });
  sourceImage.crop.mockReturnValue({
    toDataURL: () =>
      `data:image/png;base64,${imageBytes(true).toString("base64")}`,
  });
});

describe("lettering generation binding and reuse", () => {
  it("reuses unchanged lettering and permits a separate rotation without regeneration", async () => {
    const { client, context, previous } = fixture();
    const result = await generateLetteringLayers(
      { ...page, blocks: [{ ...block, rotationDeg: 15 }] },
      reading,
      (id) => id,
      client,
      "C:/tmp/lettering-test",
      new AbortController().signal,
      context,
    );
    expect(client.runEphemeralTurn).not.toHaveBeenCalled();
    expect(sourceImage.open).not.toHaveBeenCalled();
    expect(result.page.blocks[0].generatedLettering).toEqual(
      previous.generatedLettering,
    );
    expect(result.issues).toEqual([]);
  });

  it("conditions generation on the original source crop even after erasure and moved placement", async () => {
    const { client, context } = fixture();
    const result = await generateLetteringLayers(
      {
        ...page,
        inpaintedImagePath: "cleaned.png",
        blocks: [{ ...block, renderBbox: { x: 500, y: 600, w: 200, h: 100 } }],
      },
      reading,
      (id) => id,
      client,
      "C:/tmp/lettering-test",
      new AbortController().signal,
      context,
    );
    expect(result.issues).toEqual([]);
    expect(readFile).toHaveBeenCalledExactlyOnceWith("original.png");
    expect(result.page.blocks[0].generatedLettering?.dataUrl).toBe(
      `data:image/png;base64,${imageBytes().toString("base64")}`,
    );
    expect(sourceImage.crop).toHaveBeenCalledExactlyOnceWith({
      x: 100,
      y: 150,
      width: 100,
      height: 150,
    });
    const request = client.runEphemeralTurn.mock.calls[0][0];
    expect(request.input.slice(1)).toEqual([
      {
        type: "image",
        url: `data:image/png;base64,${imageBytes(true).toString("base64")}`,
        detail: "original",
      },
    ]);
    expect(request.input[0].text).toContain("ORIGINAL source lettering crop");
    expect(request.input[0].text).toContain('target="ドン"');
    expect(request.input[0].text).toContain("full canvas maps edge-to-edge");
    expect(request.input[0].text).toContain("relative positions");
  });

  it.each([
    { bold: false },
    { italic: true },
    { textColor: "#ff0000" },
    { outlineColor: "#ffffff" },
    { outlineWidthPx: 2 },
    { fontFamily: "another-font" },
    { renderBbox: { ...bounds, w: 200 } },
    { translatedText: "쿵" },
  ])(
    "regenerates when bound treatment or wording changes: %j",
    async (change) => {
      const { client, context } = fixture();
      const result = await generateLetteringLayers(
        { ...page, blocks: [{ ...block, ...change }] },
        reading,
        (id) => id,
        client,
        "C:/tmp/lettering-test",
        new AbortController().signal,
        context,
      );
      expect(client.runEphemeralTurn).toHaveBeenCalledTimes(1);
      expect(result.issues).toEqual([]);
      expect(result.page.blocks[0].generatedLettering?.translatedText).toBe(
        change.translatedText ?? block.translatedText,
      );
    },
  );

  it("prints plain text with per-run styles instead of markup syntax", async () => {
    const { client, context } = fixture();
    const translatedText = serializeRichTextRuns([
      { text: "콰", bold: true, italic: false, sizePx: 60, color: "#aa0000" },
      { text: "앙!", bold: false, italic: false, sizePx: 30 },
    ]);
    const result = await generateLetteringLayers(
      { ...page, blocks: [{ ...block, translatedText }] },
      reading,
      (id) => id,
      client,
      "C:/tmp/lettering-test",
      new AbortController().signal,
      context,
    );
    const prompt = client.runEphemeralTurn.mock.calls[0][0].input[0].text;
    expect(prompt).toContain('Render exactly "콰앙!"');
    expect(prompt).not.toContain("[size=");
    expect(prompt).toContain('"sizePx":60');
    expect(result.page.blocks[0].generatedLettering?.translatedText).toBe(
      translatedText,
    );
  });

  it("rejects opaque output and never silently keeps it as accepted lettering", async () => {
    const { client, context } = fixture();
    context.issues = [{ regionId: "r", kind: "image", reason: "bad style" }];
    client.runEphemeralTurn.mockResolvedValue({
      text: JSON.stringify({ result: imageBytes(true).toString("base64") }),
      threadId: "t",
      turnId: "t",
      itemId: "i",
      routedModel: "gpt-6-astra",
    });
    await expect(
      generateLetteringLayers(
        page,
        reading,
        (id) => id,
        client,
        "C:/tmp/lettering-test",
        new AbortController().signal,
        context,
      ),
    ).rejects.toThrow("효과음 생성 실패");
    expect(client.runEphemeralTurn).toHaveBeenCalledOnce();
  });

  it("honors cancellation before any image request", async () => {
    const { client, context } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateLetteringLayers(
        page,
        reading,
        (id) => id,
        client,
        "C:/tmp/lettering-test",
        controller.signal,
        context,
      ),
    ).rejects.toThrow();
    expect(client.runEphemeralTurn).not.toHaveBeenCalled();
  });
});

it("extracts real alpha from the requested matte while preserving black strokes, white outline and antialiasing", async () => {
  const { client, context } = fixture();
  context.previousPage = undefined;
  const png = new PNG({ width: 4, height: 1 });
  png.data.set([
    0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 0, 128, 0, 255,
  ]);
  client.runEphemeralTurn.mockResolvedValue({
    text: JSON.stringify({ result: PNG.sync.write(png).toString("base64") }),
    threadId: "t",
    turnId: "t",
    itemId: "i",
    routedModel: "gpt-6-astra",
  });
  const result = await generateLetteringLayers(
    page,
    reading,
    (id) => id,
    client,
    "C:/tmp/lettering-test",
    new AbortController().signal,
    context,
  );
  const asset = result.page.blocks[0].generatedLettering;
  if (!asset) throw new Error("Generated lettering missing");
  const actual = PNG.sync.read(
    Buffer.from(asset.dataUrl.split(",")[1], "base64"),
  );
  expect([...actual.data]).toEqual([
    0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 127,
  ]);
  expect(client.runEphemeralTurn).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "excludes reference pixels without clipping the completed asset, including partial image failure (scoped=%s)",
  async (scoped) => {
    const { client, context } = fixture();
    context.previousPage = undefined;
    const second = { ...block, id: "second" };
    const stroke = {
      space: "page" as const,
      mode: "hide" as const,
      shape: "circle" as const,
      points: [{ x: 200, y: 300 }],
      radiusX: 20,
      radiusY: 20,
      softness: 0,
    };
    client.runEphemeralTurn.mockReset();
    const source = new PNG({ width: page.width, height: page.height });
    source.data.fill(80);
    for (let at = 3; at < source.data.length; at += 4) source.data[at] = 255;
    const sourceBytes = PNG.sync.write(source);
    sourceImage.open.mockReturnValue(rasterImage(sourceBytes));
    const mask = new PNG({ width: page.width, height: page.height });
    mask.data.fill(255);
    mask.data.fill(
      0,
      (150 * page.width + 100) * 4,
      (150 * page.width + 101) * 4 - 1,
    );
    client.runEphemeralTurn
      .mockResolvedValueOnce({
        text: JSON.stringify({ result: imageBytes().toString("base64") }),
        threadId: "t",
        turnId: "t",
        itemId: "i",
        routedModel: "gpt-6-astra",
      })
      .mockRejectedValueOnce(new Error("offline"));
    const promise = generateLetteringLayers(
      { ...page, blocks: [block, second] },
      {
        ...reading,
        editProtection: {
          strokes: [stroke],
          maskDataUrl: `data:image/png;base64,${PNG.sync.write(mask).toString("base64")}`,
          ...(scoped
            ? {
                regions: [
                  {
                    regionId: reading.regions[0].id,
                    maskDataUrl: `data:image/png;base64,${PNG.sync.write(mask).toString("base64")}`,
                  },
                ],
              }
            : {}),
        },
        regions: [...reading.regions, { ...reading.regions[0], id: second.id }],
      },
      (id) => id,
      client,
      "C:/tmp/lettering-test",
      new AbortController().signal,
      context,
    );
    const error: unknown = await promise.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(CodexLetteringGenerationError);
    if (!(error instanceof CodexLetteringGenerationError))
      throw Error("Missing partial composition");
    expect(
      error.page.blocks[0].generatedLettering?.maskStrokes,
    ).toBeUndefined();
    expect(error.page.blocks[0].generatedLettering?.dataUrl).toBeTruthy();
    expect(error.page.blocks[1].generatedLettering).toBeUndefined();
    expect(client.runEphemeralTurn).toHaveBeenCalledTimes(2);
    const request: Parameters<CodexAppServerClient["runEphemeralTurn"]>[0] =
      client.runEphemeralTurn.mock.calls[0][0];
    const reference = request.input.find((item) => item.type === "image");
    if (reference?.type !== "image") throw Error("Missing reference");
    const sent = PNG.sync.read(
      Buffer.from(reference.url.split(",")[1], "base64"),
    );
    expect([...sent.data.subarray(0, 8)]).toEqual([
      255, 255, 255, 255, 80, 80, 80, 255,
    ]);
    expect(sourceBytes).toEqual(PNG.sync.write(source));
    const otherRequest: typeof request =
      client.runEphemeralTurn.mock.calls[1][0];
    const otherReference = otherRequest.input.find(
      (item) => item.type === "image",
    );
    if (otherReference?.type !== "image")
      throw Error("Missing second reference");
    const other = PNG.sync.read(
      Buffer.from(otherReference.url.split(",")[1], "base64"),
    );
    expect(other.data[0]).toBe(scoped ? 80 : 255);
  },
  // The native-image stand-in repeatedly encodes full-page PNGs. Keep the
  // full-resolution pixel assertions on slower Windows coverage runners.
  45_000,
);

it.each(["mixed-matte", "colored-alpha"])(
  "preserves valid alpha while handling %s",
  async (mode) => {
    const { client, context } = fixture();
    context.previousPage = undefined;
    const png = new PNG({ width: 5, height: 5 });
    if (mode === "mixed-matte")
      for (let at = 0; at < png.data.length; at += 4)
        png.data.set([0, 255, 0, 255], at);
    png.data.fill(0, 0, 4);
    png.data.set(
      mode === "mixed-matte" ? [0, 0, 0, 128] : [0, 220, 0, 128],
      48,
    );
    client.runEphemeralTurn.mockResolvedValue({
      text: JSON.stringify({ result: PNG.sync.write(png).toString("base64") }),
      threadId: "t",
      turnId: "t",
      itemId: "i",
      routedModel: "gpt-6-astra",
    });
    const result = await generateLetteringLayers(
      page,
      reading,
      (id) => id,
      client,
      "C:/tmp/lettering-test",
      new AbortController().signal,
      context,
    );
    const image = result.page.blocks[0].generatedLettering;
    if (!image) throw Error("Missing layer");
    const actual = PNG.sync.read(
      Buffer.from(image.dataUrl.split(",")[1], "base64"),
    );
    expect(actual.data[3]).toBe(0);
    expect(actual.data[51]).toBe(128);
    expect(actual.data[7]).toBe(0);
    if (mode === "colored-alpha") expect(actual.data).toEqual(png.data);
  },
);
