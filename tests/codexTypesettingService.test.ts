import { reviewCodexPageBatches } from "../src/main/application/codexTypesettingPlanning";
import { describe, expect, it } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { CodexTypesettingPorts } from "../src/main/application/codexTypesettingContracts";
import { runCodexTypesetting } from "../src/main/application/codexTypesettingService";
import { failedRegionClosure } from "../src/main/application/codexTypesettingFallback";
import { qualifyJapaneseReading } from "../src/main/application/codexTypesettingValidation";
import { inspectGeneratedLettering } from "../src/main/application/codexTypesettingReadback";

const regions = ["good", "bad"].map((id, at) => ({
  id,
  action: "text",
  sourceText: "こんにちは",
  translatedText: "안녕",
  sourceBbox: { x: at * 500, y: 100, w: 100, h: 100 },
  renderBbox: { x: at * 500, y: 100, w: 150, h: 100 },
  role: "ordinary",
  direction: "vertical",
  background: "white",
  reason: "dialogue",
}));
const page: MangaPage = {
  id: "page",
  name: "001.png",
  imagePath: "source.png",
  width: 1000,
  height: 1500,
  blocks: [],
  dataUrl: "",
  analysisStatus: "idle",
  createdAt: "",
  updatedAt: "",
};
const groups = [
  {
    id: "family",
    description: "same family",
    members: regions.map((region) => ({
      regionId: `page:${region.id}`,
      bold: false,
      italic: false,
    })),
  },
];

const view = {
  bounds: { x: 0, y: 0, w: 1000, h: 1500 },
  ownership: { x: 0, y: 0, w: 1000, h: 1500 },
};

describe("chapter typesetting acceptance", () => {
  it("reads synthesized text without exposing the expected wording and rejects a changed syllable", async () => {
    const reading = qualifyJapaneseReading(
      {
        unreadableRegions: [],
        ownedReadability: "readable",
        contextReadability: "absent",
        readabilityReason: "",
        summary: "",
        regions,
      },
      "page",
    );
    const rendered: MangaPage = {
      ...page,
      blocks: [
        {
          id: "page:good",
          bbox: regions[0].sourceBbox,
          type: "nonsolid",
          sourceText: "こんにちは",
          translatedText: "쾅",
          confidence: 1,
          sourceDirection: "horizontal",
          renderDirection: "horizontal",
          fontSizePx: 30,
          lineHeight: 1.2,
          textAlign: "center",
          textColor: "#000000",
          opacity: 0,
          backgroundColor: "#ffffff",
          generatedLettering: {
            version: 1,
            sourceText: "こんにちは",
            translatedText: "쾅",
            dataUrl: "image-pixels",
          },
        },
      ],
    };
    const issues = await inspectGeneratedLettering(rendered, reading, 0, {
      targetLanguage: "ko",
      blockId: (id) => id,
      ask: async (_stage, prompt, images) => {
        expect(prompt).not.toContain("쾅");
        expect(images).toEqual([
          { label: "page:good", dataUrl: "image-pixels" },
        ]);
        return { regions: [{ regionId: "page:good", text: "쿵" }] };
      },
    });
    expect(issues).toEqual([
      {
        regionId: "page:good",
        kind: "image",
        reason: '독립 재판독 불일치: "쿵"; 필요한 문구: "쾅"',
      },
    ]);
  });

  it.each(["text", "background"] as const)(
    "retains the first %s result and exposes findings without automatic repair",
    async (kind) => {
      const stages: string[] = [];
      const restored: string[][] = [];
      const committed: MangaPage[] = [];
      const cleanedRegions: string[][] = [];
      const repairs: number[] = [];
      const previews: string[] = [];
      const ports: CodexTypesettingPorts = {
        preview: (proposed, reading, stage) => {
          expect(committed).toHaveLength(0);
          if (stage === "reading") expect(reading?.regions).toHaveLength(2);
          if (stage === "background")
            expect(proposed.inpaintedImagePath).toBe("clean.png");
          previews.push(stage);
        },
        inspectBackground: async () => ({
          issues:
            kind === "background"
              ? [{ regionId: "page:bad", reason: "residual source", kind }]
              : [],
          corrections: [],
        }),
        targetLanguage: "ko",
        signal: new AbortController().signal,
        blockId: (id) => id,
        readPage: async () => [
          { label: "source", dataUrl: "test-image", view },
        ],
        cropRegions: async (_pages, readings, includeContext) => {
          if (includeContext) {
            expect(stages).toEqual(["read-page"]);
          } else {
            expect(stages).toEqual(["read-page", "erase-page"]);
            expect(readings.get("page")?.regions[1].sourceBbox.x).toBeLessThan(
              regions[1].sourceBbox.x,
            );
          }
          return [{ label: "all source crops", dataUrl: "test-crops" }];
        },
        fontSamples: async () => [],
        cleanPage: async (source, reading, repair) => {
          cleanedRegions.push(reading.regions.map((region) => region.id));
          if (repair) {
            repairs.push(repair.attempt);
            expect(source.inpaintedImagePath).toBe("clean.png");
            expect(repair.issues[0].kind).toBe(kind);
          }
          return {
            page: { ...source, inpaintedImagePath: "clean.png" },
            issues: [],
          };
        },
        illustrate: async (proposed) => ({ page: proposed, issues: [] }),
        restoreRegions: async (proposed, _reading, ids) => {
          restored.push(ids);
          return proposed;
        },
        render: async () => [
          {
            view,
            label: "production render",
            dataUrl: "test-render",
          },
        ],
        progress: (update) => {
          if (update.pageCommitted) expect(committed).toHaveLength(1);
        },
        saveEvidence: async () => {},
        commit: async (proposed) => {
          committed.push(proposed);
        },
        ask: async (stage) => {
          stages.push(stage);
          if (stage.startsWith("read-"))
            return {
              unreadableRegions: [],
              ownedReadability: "readable",
              contextReadability: "absent",
              readabilityReason: "",
              summary: "",
              regions,
            };
          if (stage.startsWith("erase-"))
            return {
              regions: regions.map((region) => ({
                regionId: `page:${region.id}`,
                erasePolygons: [
                  [
                    { x: 0, y: 0 },
                    { x: 1000, y: 0 },
                    { x: 1000, y: 1000 },
                    { x: 0, y: 1000 },
                  ],
                ],
                background: "white",
                reason: "plain balloon",
              })),
            };
          if (stage === "source-families") return { groups };
          if (stage === "font-assignment")
            return { fonts: [{ groupId: "family", fontId: "custom" }] };
          if (stage.startsWith("review-"))
            return {
              issues:
                kind === "text"
                  ? [{ regionId: "page:bad", reason: "clipped", kind }]
                  : [],
            };
          return {
            layouts: regions.map((region) => ({
              regionId: `page:${region.id}`,
              translatedText: "안녕",
              renderBbox: region.renderBbox,
              fontSizePx: 24,
              lineHeight: 1.2,
              rotationDeg: 0,
              outlineWidthPx: 0,
              textColor: "#000000",
              outlineColor: "#ffffff",
              textAlign: "center",
              direction: "horizontal",
            })),
          };
        },
      };
      const result = await runCodexTypesetting(
        [page],
        {
          version: 1,
          preset: {
            id: "preset",
            name: "Custom",
            fonts: [{ fontId: "custom", purpose: "ordinary" }],
          },
        },
        ports,
      );
      expect(
        stages.filter((stage) => stage.startsWith("layout-")),
      ).toHaveLength(1);
      expect(
        stages.filter((stage) => stage.startsWith("review-")),
      ).toHaveLength(1);
      expect(restored).toEqual([]);
      expect(cleanedRegions).toEqual([["page:good", "page:bad"]]);
      expect(repairs).toEqual([]);
      expect(previews).toEqual(["reading", "background"]);
      expect(committed).toHaveLength(1);
      expect(result.pages[0].blocks[0].translatedText).toBe("안녕");
      expect(result.pages[0].blocks[0].inpaintExcluded).not.toBe(true);
      expect(result.pages[0].blocks[1]).toMatchObject({
        reviewStatus: "needs_review",
        translatedText: "안녕",
      });
      expect(result.pages[0].blocks[1].textOpacity).not.toBe(0);
      expect(result.pages[0].blocks[1].inpaintExcluded).not.toBe(true);
      expect(stages.indexOf("source-families")).toBeLessThan(
        stages.indexOf("font-assignment"),
      );
    },
  );

  it("restores overlapping translations as a connected group and rejects fabricated review IDs", () => {
    const reading = qualifyJapaneseReading(
      {
        unreadableRegions: [],
        ownedReadability: "readable",
        contextReadability: "absent",
        readabilityReason: "",
        summary: "",
        regions,
      },
      "page",
    );
    const overlapping = {
      ...page,
      blocks: [{ id: "page:good", renderBbox: regions[1].sourceBbox }],
    } as MangaPage;
    expect(
      failedRegionClosure(
        reading,
        overlapping,
        ["page:bad"],
        (id) => id,
      ).sort(),
    ).toEqual(["page:bad", "page:good"]);
    expect(() =>
      failedRegionClosure(reading, page, ["page:invented"], (id) => id),
    ).toThrow();
  });
});

it("reviews overflow from the actual renderer while accepting intentional original lettering when erasure is off", async () => {
  const reading = qualifyJapaneseReading(
    {
      unreadableRegions: [],
      ownedReadability: "readable",
      contextReadability: "absent",
      readabilityReason: "",
      summary: "",
      regions,
    },
    "page",
  );
  const image = { label: "page", dataUrl: "pixels", view };
  const preview = {
    ...image,
    measurements: [
      { regionId: "page:good", overflow: true },
      { regionId: "page:bad", overflow: false },
    ],
  } as Parameters<typeof reviewCodexPageBatches>[3][number];
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected non-review stage");
  };
  const result = await reviewCodexPageBatches(
    page,
    reading,
    [image],
    [preview],
    0,
    {
      targetLanguage: "ko",
      readPage: unexpected,
      cropRegions: unexpected,
      fontSamples: unexpected,
      cleanPage: unexpected,
      inspectBackground: unexpected,
      restoreRegions: unexpected,
      illustrate: unexpected,
      render: unexpected,
      saveEvidence: unexpected,
      commit: unexpected,
      eraseOriginal: false,
      signal: new AbortController().signal,
      progress: () => undefined,
      blockId: (id: string) => id,
      ask: async (_stage: string, prompt: string) => {
        expect(prompt).toContain("Original erasure is OFF");
        return { issues: [] };
      },
    },
  );
  expect(result.issues).toEqual([
    expect.objectContaining({ regionId: "page:good", kind: "text" }),
  ]);
});
