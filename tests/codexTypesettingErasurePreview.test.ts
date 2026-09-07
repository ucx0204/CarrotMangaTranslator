import { PNG } from "pngjs";
import { describe, expect, it, vi } from "vitest";
import { createCodexErasurePreview } from "../src/main/pipeline/codexTypesettingErasurePreview";
import type { CodexPageReading } from "../src/shared/codexTypesettingTypes";
import type { MangaPage } from "../src/shared/libraryTypes";
import { codexSourceContextRect } from "../src/shared/codexTypesettingMask";
import {
  qualifyJapaneseReading,
  typesettingOutputSchema,
  erasurePlansSchema,
} from "../src/main/application/codexTypesettingValidation";

const page: MangaPage = {
  id: "p",
  name: "synthetic",
  width: 100,
  height: 100,
  imagePath: "unused.png",
  dataUrl: "",
  blocks: [],
  analysisStatus: "completed",
  createdAt: "",
  updatedAt: "",
};
function setup(background: "white" | "black" | "artwork" = "white") {
  const reading: CodexPageReading = {
    summary: "",
    regions: [
      {
        id: "p:r1",
        action: "text",
        sourceText: "かな",
        translatedText: "일까",
        role: "ordinary",
        direction: "vertical",
        background,
        reason: "",
        sourceBbox: { x: 200, y: 200, w: 200, h: 200 },
        renderBbox: { x: 700, y: 700, w: 100, h: 100 },
      },
    ],
  };
  const crop = codexSourceContextRect(reading.regions[0], page);
  const image = new PNG({ width: crop.w, height: crop.h });
  image.data.fill(255);
  for (let y = 20; y < 40; y++)
    for (let x = 20; x < 40; x++)
      image.data.fill(0, (y * crop.w + x) * 4, (y * crop.w + x) * 4 + 3);
  const original =
    "data:image/png;base64," + PNG.sync.write(image).toString("base64");
  const signal = new AbortController(),
    evidence = vi.fn(
      async (_name: string, _value: unknown): Promise<void> => {},
    );
  const context = {
    page,
    reading,
    images: [{ label: "p:r1; original context crop", dataUrl: original }],
    stage: "erase-p",
    signal: signal.signal,
    evidence,
  };
  const plans = (right = 40) => ({
    regions: [
      {
        regionId: "p:r1",
        background,
        reason: "coverage",
        erasePolygons: [
          [
            { x: (20 / crop.w) * 1000, y: (20 / crop.h) * 1000 },
            { x: (right / crop.w) * 1000, y: (20 / crop.h) * 1000 },
            { x: (right / crop.w) * 1000, y: (40 / crop.h) * 1000 },
            { x: (20 / crop.w) * 1000, y: (40 / crop.h) * 1000 },
          ],
        ],
      },
    ],
  });
  return { context, plans, signal, original };
}

function reference(
  context: ReturnType<typeof setup>["context"],
  index = context.evidence.mock.calls.length - 1,
) {
  const record = context.evidence.mock.calls[index]?.[1] as
    | {
        revision: number;
        sha256: string;
        unresolvedRegionIds: string[];
      }
    | undefined;
  if (!record) throw new Error("Missing preview evidence");
  return {
    revision: record.revision,
    sha256: record.sha256,
    unresolvedRegionIds: record.unresolvedRegionIds,
  };
}

describe("actual erasure preview and final proposal binding", () => {
  it("renders detailed contours under the same vertex bound advertised to the tool", async () => {
    const { context, plans } = setup("artwork");
    const detailed = plans();
    const polygon = detailed.regions[0].erasePolygons[0];
    detailed.regions[0].erasePolygons = [
      polygon.flatMap((a, edge) => {
        const b = polygon[(edge + 1) % polygon.length];
        return Array.from({ length: 64 }, (_, index) => ({
          x: a.x + ((b.x - a.x) * index) / 64,
          y: a.y + ((b.y - a.y) * index) / 64,
        }));
      }),
    ];
    const schema = typesettingOutputSchema("erase-preview") as {
      properties: {
        regions: {
          items: {
            properties: { erasePolygons: { items: { maxItems: number } } };
          };
        };
      };
    };
    expect(
      schema.properties.regions.items.properties.erasePolygons.items.maxItems,
    ).toBe(256);
    const preview = createCodexErasurePreview(context);
    await expect(preview.tool.execute(detailed)).resolves.toMatchObject({
      success: true,
    });
    expect(preview.verify(reference(context))).toEqual(detailed);
    detailed.regions[0].erasePolygons[0].push(polygon[0]);
    expect(() => erasurePlansSchema.parse(detailed)).toThrow();
    const failed = createCodexErasurePreview(context);
    await expect(failed.tool.execute(detailed)).rejects.toThrow(/256/);
    await expect(failed.tool.execute(plans())).rejects.toThrow(/한 번/);
    expect(() => failed.verify(reference(context))).toThrow(/256/);
  });

  it("preserves non-Error tool failures as the final failure cause", async () => {
    const { context, plans } = setup();
    context.evidence.mockRejectedValueOnce("storage unavailable");
    const preview = createCodexErasurePreview(context);
    await expect(preview.tool.execute(plans())).rejects.toThrow(
      "storage unavailable",
    );
    expect(() => preview.verify({})).toThrow("storage unavailable");
  });

  it("shows the first proposal without moving the editable destination or silently retrying", async () => {
    const { context, plans, original } = setup(),
      preview = createCodexErasurePreview(context);
    expect(() => preview.verify(plans())).toThrow(/미리보기/);
    await preview.tool.execute(plans(35));
    const first = context.evidence.mock.calls[0][1] as {
      images: Array<{ dataUrl: string }>;
    };
    const decode = (data: string) =>
      PNG.sync.read(Buffer.from(data.split(",")[1], "base64"));
    const incomplete = decode(first.images[2].dataUrl);
    expect(incomplete.data[(25 * incomplete.width + 38) * 4]).toBe(0);
    await expect(preview.tool.execute(plans())).rejects.toThrow("한 번");
    expect(preview.verify(reference(context))).toEqual(plans(35));
    const fresh = createCodexErasurePreview(context);
    await fresh.tool.execute(plans());
    const last = context.evidence.mock.calls[1][1] as {
      images: Array<{ dataUrl: string }>;
    };
    const clean = decode(last.images[2].dataUrl),
      source = decode(original);
    for (let y = 0; y < clean.height; y++)
      for (let x = 0; x < clean.width; x++) {
        const at = (y * clean.width + x) * 4;
        expect(clean.data.subarray(at, at + 4)).toEqual(
          x >= 20 && x < 40 && y >= 20 && y < 40
            ? Buffer.from([255, 255, 255, 255])
            : source.data.subarray(at, at + 4),
        );
      }
    expect(context.images[0].dataUrl).toBe(original);
    expect(context.reading.regions[0].renderBbox.x).toBe(700);
    expect(() => fresh.verify({ ...reference(context), revision: 2 })).toThrow(
      /미리보기/,
    );
    expect(() =>
      fresh.verify({ ...reference(context), sha256: "0".repeat(64) }),
    ).toThrow(/미리보기/);
    expect(() => fresh.verify(plans(39))).toThrow();
    const resolved = fresh.verify(reference(context));
    resolved.regions[0].reason = "mutated consumer copy";
    expect(fresh.verify(reference(context))).toEqual(plans());
  });

  it.each(["black", "artwork"] as const)(
    "distinguishes %s treatment from restored artwork",
    async (background) => {
      const { context, plans } = setup(background);
      const response =
        await createCodexErasurePreview(context).tool.execute(plans());
      const images = response.contentItems.filter(
        (item) => item.type === "inputImage",
      );
      expect(images).toHaveLength(background === "black" ? 3 : 2);
      const text = response.contentItems
        .filter((item) => item.type === "inputText")
        .map((item) => item.text)
        .join(" ");
      expect(text).toContain("not restored artwork");
      if (background === "black")
        expect(text).toContain("ACTUAL black erase preview");
    },
  );

  it("keeps empty masks visibly unresolved, and enforces membership and protected digits", async () => {
    const { context, plans } = setup(),
      preview = createCodexErasurePreview(context);
    const empty = plans();
    empty.regions[0].erasePolygons = [];
    const result = await preview.tool.execute(empty);
    expect(preview.verify(reference(context))).toEqual(empty);
    expect(() =>
      preview.verify({ ...reference(context), unresolvedRegionIds: [] }),
    ).toThrow(/acknowledgement/);
    expect(() =>
      preview.verify({
        ...reference(context),
        unresolvedRegionIds: ["p:r1", "p:r1"],
      }),
    ).toThrow(/acknowledgement/);
    expect(
      result.contentItems.some(
        (item) => item.type === "inputText" && item.text.includes("UNRESOLVED"),
      ),
    ).toBe(true);
    const wrong = plans();
    wrong.regions[0].regionId = "unknown";
    await expect(
      createCodexErasurePreview(context).tool.execute(wrong),
    ).rejects.toThrow(/exactly once/);
    context.reading.regions.push({
      ...context.reading.regions[0],
      id: "digit",
      action: "keep",
      sourceText: "7",
    });
    const protectedPreview = createCodexErasurePreview(context);
    await protectedPreview.tool.execute(plans());
    expect(reference(context).unresolvedRegionIds).toEqual(["p:r1"]);
    expect(
      protectedPreview.verify(reference(context)).regions[0].erasePolygons,
    ).toEqual([]);
    await expect(protectedPreview.tool.execute(plans())).rejects.toThrow(
      /한 번만/,
    );
  });

  it("refuses mismatched source crops, failed evidence and cancellation", async () => {
    const { context, plans, signal } = setup();
    context.images[0].label = "other; original context crop";
    await expect(
      createCodexErasurePreview(context).tool.execute(plans()),
    ).rejects.toThrow(/ID/);
    context.images[0].label = "p:r1; original context crop";
    context.evidence.mockRejectedValueOnce(new Error("disk full"));
    const preview = createCodexErasurePreview(context);
    await expect(preview.tool.execute(plans())).rejects.toThrow("disk full");
    expect(() => preview.verify(plans())).toThrow(/disk full/);
    signal.abort();
    await expect(preview.tool.execute(plans())).rejects.toThrow();
  });

  it("refuses erasure through a localized unreadable source produced by the reading gateway", async () => {
    const { context, plans, original } = setup();
    context.reading = qualifyJapaneseReading(
      {
        ownedReadability: "partial",
        contextReadability: "absent",
        readabilityReason: "localized uncertainty",
        summary: "",
        regions: [{ ...context.reading.regions[0], id: "r1" }],
        unreadableRegions: [
          {
            id: "unknown",
            sourceBbox: context.reading.regions[0].sourceBbox,
            reason: "overlapping unclear handwriting",
          },
        ],
      },
      "p",
    );
    const preview = createCodexErasurePreview(context);
    const response = await preview.tool.execute(plans());
    expect(context.evidence).toHaveBeenCalledOnce();
    expect(
      response.contentItems.filter((item) => item.type === "inputImage"),
    ).toHaveLength(1);
    expect(
      JSON.stringify(
        response.contentItems.filter((item) => item.type === "inputText"),
      ),
    ).toContain("p:unknown");
    expect(preview.verify(reference(context)).regions[0].erasePolygons).toEqual(
      [],
    );
    expect(context.images[0].dataUrl).toBe(original);
  });

  it("returns a clean valid region beside a blocked region and binds their exact partial artifact", async () => {
    const { context, plans, original } = setup();
    context.reading.regions.push({ ...context.reading.regions[0], id: "p:r2" });
    context.reading.regions.push({
      ...context.reading.regions[0],
      id: "star",
      action: "keep",
      sourceText: "☆",
      sourceBbox: { x: 300, y: 200, w: 100, h: 200 },
    });
    context.images.push({
      ...context.images[0],
      label: "p:r2; original context crop",
    });
    const proposed = plans();
    proposed.regions.push({ ...plans(25).regions[0], regionId: "p:r2" });
    const preview = createCodexErasurePreview(context);
    const result = await preview.tool.execute(proposed);
    expect(reference(context).unresolvedRegionIds).toEqual(["p:r1"]);
    const resolved = preview.verify(reference(context));
    expect(resolved.regions[0].erasePolygons).toEqual([]);
    expect(resolved.regions[1]).toEqual(proposed.regions[1]);
    const images = result.contentItems.filter(
      (item) => item.type === "inputImage",
    );
    expect(images).toHaveLength(4);
    const clean = PNG.sync.read(
      Buffer.from(images[3].imageUrl.split(",")[1], "base64"),
    );
    expect(clean.data[(25 * clean.width + 22) * 4]).toBe(255);
    expect(clean.data[(25 * clean.width + 35) * 4]).toBe(0);
    const metadata = JSON.stringify(
      result.contentItems.filter((item) => item.type === "inputText"),
    );
    expect(metadata).toContain("star");
    expect(metadata).toContain("contextBbox");
    expect(context.images[0].dataUrl).toBe(original);
    expect(() =>
      preview.verify({ ...reference(context), unresolvedRegionIds: ["p:r2"] }),
    ).toThrow(/acknowledgement/);
  });
});
