import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inspectTypesettingBackground } from "../src/main/pipeline/codexTypesettingBackgroundInspection";
import { restoreSourceRegions } from "../src/main/pipeline/codexTypesettingRaster";
import {
  cleanIllustratedRegions,
  type TypesettingBackgroundCache,
} from "../src/main/pipeline/codexTypesettingImageGeneration";
import {
  typesettingOutputSchema,
  type backgroundReviewSchema,
} from "../src/main/application/codexTypesettingValidation";
import type { CodexPageReading } from "../src/shared/codexTypesettingTypes";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { CodexAppServerClient } from "../src/main/codexAppServerClient";

const files = vi.hoisted(() => new Map<string, Buffer>());
function fixtureBytes(name: string): Buffer {
  const bytes = files.get(name);
  if (!bytes) throw new Error(`Missing fixture: ${name}`);
  return bytes;
}
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (name: string) => {
    const bytes = files.get(name);
    if (!bytes) throw new Error(`Missing ${name}`);
    return bytes;
  }),
  writeFile: vi.fn(async (name: string, bytes: Buffer | string) => {
    files.set(name, Buffer.from(bytes));
  }),
}));
vi.mock("electron", async () => {
  const { PNG: Raster } = await import("pngjs");
  function image(bytes: Buffer) {
    const png = Raster.sync.read(bytes);
    return {
      isEmpty: () => false,
      getSize: () => ({ width: png.width, height: png.height }),
      toPNG: () => bytes,
      toDataURL: () => `data:image/png;base64,${bytes.toString("base64")}`,
      crop: ({
        x,
        y,
        width,
        height,
      }: {
        x: number;
        y: number;
        width: number;
        height: number;
      }) => {
        const crop = new Raster({ width, height });
        Raster.bitblt(png, crop, x, y, width, height, 0, 0);
        return image(Raster.sync.write(crop));
      },
      resize: ({ width, height }: { width: number; height: number }) => {
        if (png.width !== width || png.height !== height)
          throw new Error("Fixture resize requires native dimensions");
        return image(bytes);
      },
    };
  }
  return {
    nativeImage: {
      createFromBuffer: image,
      createFromPath: (path: string) => image(fixtureBytes(path)),
    },
  };
});

function raster(value: number) {
  const png = new PNG({ width: 100, height: 100 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data.fill(value, i, i + 3);
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}
const page: MangaPage = {
  id: "p",
  name: "fixture",
  imagePath: "source.png",
  inpaintedImagePath: "background.png",
  width: 100,
  height: 100,
  blocks: [],
  dataUrl: "",
  analysisStatus: "idle",
  createdAt: "",
  updatedAt: "",
};
function harness() {
  const reading: CodexPageReading = {
    summary: "",
    regions: [
      {
        id: "effect",
        action: "image",
        sourceText: "ギロ",
        translatedText: "찌릿",
        sourceBbox: { x: 0, y: 0, w: 400, h: 400 },
        renderBbox: { x: 0, y: 0, w: 400, h: 400 },
        background: "artwork",
        role: "sound",
        direction: "horizontal",
        reason: "effect",
      },
    ],
  };
  const sha256 = createHash("sha256")
    .update(fixtureBytes("background.png"))
    .digest("hex");
  const response: ReturnType<typeof backgroundReviewSchema.parse> = {
    revision: 1,
    sha256,
    issues: [],
    corrections: [],
  };
  return {
    composition: {
      page,
      issues: [],
      backgroundCandidates: [
        {
          regionId: "effect",
          dataUrl: `data:image/png;base64,${fixtureBytes("raw.png").toString("base64")}`,
          sha256: "raw-hash",
          crop: { x: 0, y: 0, w: 72, h: 72 },
        },
      ],
    },
    reading,
    attempt: 0,
    directory: "owned",
    signal: new AbortController().signal,
    ask: vi.fn(
      async (
        _stage: string,
        _prompt: string,
        _images: { label: string; dataUrl: string }[],
      ) => response,
    ),
    evidence: vi.fn(async (_name: string, _value: unknown) => {}),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  files.clear();
  files.set("source.png", raster(0));
  files.set("background.png", raster(255));
  files.set("raw.png", raster(90));
});

describe("actual background pixel acknowledgement", () => {
  it("records known unreadable observations without authorizing erasure or aborting valid active review", async () => {
    const h = harness();
    h.reading.regions.push({
      ...h.reading.regions[0],
      id: "unreadable",
      action: "keep",
      sourceText: "",
      translatedText: "",
      preserveReason: "Curved source is unreadable",
    });
    const response = await h.ask("", "", []);
    const active = {
      regionId: "effect",
      kind: "background" as const,
      reason: "Residual source",
    };
    const preserved = {
      ...active,
      regionId: "unreadable",
      reason: "Preserved source remains",
    };
    h.ask.mockClear();
    h.ask.mockResolvedValue({ ...response, issues: [active, preserved] });
    expect(await inspectTypesettingBackground(h)).toEqual({
      issues: [active],
      corrections: [],
    });
    expect(h.evidence).toHaveBeenCalledWith(
      "audit-background-p-0",
      expect.objectContaining({
        response: expect.objectContaining({ issues: [active, preserved] }),
        preservedObservations: [preserved],
      }),
    );
    expect(h.reading.regions[1].action).toBe("keep");
    h.ask.mockResolvedValue({
      ...response,
      corrections: [
        {
          regionId: "unreadable",
          erasePolygons: [],
          background: "white",
          reason: "Unsafe correction",
        },
      ],
    });
    await expect(inspectTypesettingBackground(h)).rejects.toThrow("대상 밖");
  });

  it("sends distinct original, actual splice and raw proposal, binds native snapshot, and distinguishes crop boundaries from physical page edges", async () => {
    const h = harness();
    Object.assign(h.composition.backgroundCandidates[0], {
      blendMask: "data:image/png;base64,fixture-mask",
      reused: true,
    });
    expect(await inspectTypesettingBackground(h)).toEqual({
      issues: [],
      corrections: [],
    });
    const [stage, prompt, images] = h.ask.mock.calls[0];
    expect(stage).toBe("background-p-0");
    expect(prompt).toContain("single-pass workflow");
    const original = images.find(
      (i) =>
        i.label.includes("original context crop") &&
        !i.label.includes("ACTUAL"),
    );
    const actual = images.find((i) =>
      i.label.includes("ACTUAL saved background crop"),
    );
    const raw = images.find((i) => i.label.includes("RAW generator output"));
    if (!original || !actual || !raw)
      throw new Error("Missing inspected fixture image");
    const pixel = (url: string) =>
      PNG.sync.read(Buffer.from(url.split(",")[1], "base64")).data[0];
    expect([
      pixel(original.dataUrl),
      pixel(actual.dataUrl),
      pixel(raw.dataUrl),
    ]).toEqual([0, 255, 90]);
    expect(original.label).toContain(
      'input-image boundaries (not necessarily physical page edges)={"left":true,"top":true',
    );
    expect(original.label).toContain("native page=100x100");
    expect(raw.label).toContain("NOT the accepted local splice");
    expect(
      images.find((image) => image.label.includes("actual splice alpha")),
    ).toMatchObject({
      dataUrl: "data:image/png;base64,fixture-mask",
      label: expect.stringContaining("reused=true"),
    });
    expect(vi.mocked(writeFile).mock.calls[0][1]).toEqual(
      files.get("background.png"),
    );
    expect(typesettingOutputSchema(stage)).toMatchObject({
      type: "object",
      required: ["revision", "sha256", "issues", "corrections"],
    });
  });

  it.each(["revision", "sha256"] as const)(
    "rejects a stale %s despite a positive quality answer",
    async (field) => {
      const h = harness();
      const response = await h.ask("", "", []);
      h.ask.mockClear();
      h.ask.mockResolvedValue({
        ...response,
        [field]: field === "revision" ? 2 : "a".repeat(64),
      });
      await expect(inspectTypesettingBackground(h)).rejects.toThrow(
        "번호·해시",
      );
      expect(h.evidence).not.toHaveBeenCalled();
    },
  );

  it("rejects a background file mutated while the model is inspecting the immutable snapshot", async () => {
    const h = harness();
    const response = await h.ask("", "", []);
    h.ask.mockClear();
    h.ask.mockImplementation(async () => {
      files.set("background.png", raster(77));
      return response;
    });
    await expect(inspectTypesettingBackground(h)).rejects.toThrow("변경");
  });

  it("does not drop a thirteenth active target and rejects a cross-batch correction", async () => {
    const h = harness();
    h.reading.regions = Array.from({ length: 13 }, (_, index) => ({
      ...h.reading.regions[0],
      id: `r${index}`,
    }));
    h.composition.backgroundCandidates = [];
    await inspectTypesettingBackground(h);
    expect(h.ask.mock.calls.map((call) => call[0])).toEqual([
      "background-p-0-batch-1",
      "background-p-0-batch-2",
    ]);
    expect(
      h.ask.mock.calls[1][2].filter((image) =>
        image.label.includes("ACTUAL saved background crop"),
      ),
    ).toHaveLength(1);
    const response = await h.ask("", "", []);
    h.ask.mockClear();
    h.ask.mockResolvedValue({
      ...response,
      corrections: [
        {
          regionId: "r12",
          background: "artwork",
          erasePolygons: [],
          reason: "wrong batch",
        },
      ],
    });
    await expect(inspectTypesettingBackground(h)).rejects.toThrow("대상 밖");
  });

  it("rejects missing background and cancellation before any model request", async () => {
    const h = harness();
    h.composition.page = { ...page, inpaintedImagePath: undefined };
    await expect(inspectTypesettingBackground(h)).rejects.toThrow("배경");
    const controller = new AbortController();
    controller.abort();
    h.signal = controller.signal;
    await expect(inspectTypesettingBackground(h)).rejects.toThrow();
    expect(h.ask).not.toHaveBeenCalled();
  });

  it("returns a visual failure and proposed correction without mutating the inspected background", async () => {
    const h = harness();
    const response = await h.ask("", "", []);
    h.ask.mockClear();
    const correction = {
      regionId: "effect",
      background: "artwork" as const,
      erasePolygons: [],
      reason: "Residual source",
    };
    const issue = {
      regionId: "effect",
      kind: "background" as const,
      reason: "Residual source",
    };
    h.ask.mockResolvedValue({
      ...response,
      issues: [issue],
      corrections: [correction],
    });
    const before = Buffer.from(fixtureBytes("background.png"));
    expect(await inspectTypesettingBackground(h)).toEqual({
      issues: [issue],
      corrections: [correction],
    });
    expect(files.get("background.png")).toEqual(before);
    expect(
      vi
        .mocked(readFile)
        .mock.calls.filter((call) => call[0] === "background.png"),
    ).toHaveLength(2);
  });
});

describe("staged and technically rejected background evidence", () => {
  it.each([0, 255])(
    "preserves raw evidence with opacity %s and reuses usable pixels only for an explicit geometry correction",
    async (opacity) => {
      const h = harness();
      files.set("background.png", Buffer.from(fixtureBytes("source.png")));
      h.reading.regions[0].erasePolygons = [
        [
          { x: 0, y: 0 },
          { x: 1000, y: 0 },
          { x: 1000, y: 1000 },
          { x: 0, y: 1000 },
        ],
      ];
      let generated: Buffer | undefined;
      const client = {
        runEphemeralTurn: vi.fn(
          async (
            request: Parameters<CodexAppServerClient["runEphemeralTurn"]>[0],
          ) => {
            const input = request.input.find((item) => item.type === "image");
            if (!input) throw new Error("Missing image input");
            const source = PNG.sync.read(
              Buffer.from(input.url.split(",")[1], "base64"),
            );
            source.data.fill(255);
            for (let i = 3; i < source.data.length; i += 4)
              source.data[i] = opacity;
            generated = PNG.sync.write(source);
            return {
              text: JSON.stringify({ result: generated.toString("base64") }),
              turnId: "fixture",
              threadId: "fixture",
              itemId: "fixture",
            };
          },
        ),
      };
      const before = Buffer.from(fixtureBytes("background.png"));
      const cache: TypesettingBackgroundCache = new Map();
      const result = await cleanIllustratedRegions(
        page,
        h.reading,
        client,
        "owned",
        h.signal,
        undefined,
        cache,
      );
      expect(result.issues).toHaveLength(opacity ? 0 : 1);
      expect(result.backgroundCandidates).toHaveLength(1);
      if (!generated || !result.backgroundCandidates)
        throw new Error("Missing generated evidence");
      expect(result.backgroundCandidates[0].sha256).toBe(
        createHash("sha256").update(generated).digest("hex"),
      );
      if (!opacity)
        expect(PNG.sync.read(fixtureBytes("background.png")).data).toEqual(
          PNG.sync.read(before).data,
        );
      else {
        expect(PNG.sync.read(fixtureBytes("background.png")).data[0]).toBe(255);
        h.reading.regions[0].erasePolygons = [
          [
            { x: 0, y: 0 },
            { x: 500, y: 0 },
            { x: 500, y: 1000 },
            { x: 0, y: 1000 },
          ],
        ];
        const reused = await cleanIllustratedRegions(
          page,
          h.reading,
          client,
          "owned",
          h.signal,
          { attempt: 1, issues: [], reuseBackgroundIds: ["effect"] },
          cache,
        );
        expect(reused.backgroundCandidates?.[0].reused).toBe(true);
        expect(reused.backgroundCandidates?.[0].blendMask).toContain(
          "data:image/png",
        );
        const metadata = [...files.entries()].find(
          ([file]) => file.includes("clean-source-") && file.endsWith(".json"),
        );
        if (!metadata) throw new Error("Missing splice metadata");
        expect(JSON.parse(metadata[1].toString())).toMatchObject({
          status: "staged-for-visual-background-review",
          registration: { accepted: false },
        });
        expect(
          [...files.keys()].filter(
            (file) => file.includes("clean-source-") && file.endsWith(".json"),
          ),
        ).toHaveLength(2);
        await restoreSourceRegions(page, h.reading, ["effect"]);
        expect(PNG.sync.read(fixtureBytes("background.png")).data).toEqual(
          PNG.sync.read(before).data,
        );
      }
      expect(client.runEphemeralTurn).toHaveBeenCalledTimes(1);
    },
  );
});
