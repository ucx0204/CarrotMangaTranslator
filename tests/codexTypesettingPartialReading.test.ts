import { readCodexPage } from "../src/main/application/codexTypesettingReading";
import { describe, expect, it, vi } from "vitest";
import { qualifyJapaneseReading } from "../src/main/application/codexTypesettingValidation";
import { runCodexTypesetting } from "../src/main/application/codexTypesettingService";
import { preservedReadingConflicts } from "../src/main/application/codexTypesettingFallback";
import { withCodexReadingReview } from "../src/main/application/codexTypesettingBlocks";
import type { CodexTypesettingPorts } from "../src/main/application/codexTypesettingContracts";
import type { MangaPage } from "../src/shared/libraryTypes";

const box = { x: 100, y: 100, w: 100, h: 100 };
const protectedBox = { x: 600, y: 300, w: 100, h: 100 };
const known = {
  id: "known",
  action: "text",
  sourceText: "待って",
  translatedText: "잠깐",
  sourceBbox: box,
  renderBbox: box,
  role: "ordinary",
  direction: "vertical",
  background: "white",
  reason: "dialogue",
};
const partial = {
  ownedReadability: "partial",
  contextReadability: "absent",
  readabilityReason: "One localized uncertain SFX",
  summary: "Story",
  regions: [known],
  unreadableRegions: [
    {
      id: "unknown",
      sourceBbox: protectedBox,
      reason: "The small final glyph is unclear.",
    },
  ],
};
const page: MangaPage = {
  id: "p1",
  name: "p1.png",
  width: 1000,
  height: 1000,
  imagePath: "original.png",
  dataUrl: "",
  blocks: [],
  analysisStatus: "idle",
  createdAt: "",
  updatedAt: "",
};
const options = {
  version: 1 as const,
  preset: {
    id: "p",
    name: "p",
    fonts: [{ fontId: "custom", purpose: "dialogue" }],
  },
};

function harness(overlapAttempts = 0, onlyUnknown = false) {
  const pages = onlyUnknown
    ? [page]
    : [page, { ...page, id: "p2", name: "p2.png" }];
  const ids = onlyUnknown ? [] : pages.map((p) => p.id + ":known");
  const view = {
    bounds: { x: 0, y: 0, w: 1000, h: 1000 },
    ownership: { x: 0, y: 0, w: 1000, h: 1000 },
  };
  const groups = [
    {
      id: "family",
      description: "source family",
      members: ids.map((regionId) => ({
        regionId,
        bold: false,
        italic: false,
      })),
    },
  ];
  const committed: MangaPage[] = [];
  const restored: string[][] = [];
  const asks: string[] = [];
  const layouts: string[] = [];
  const ports: CodexTypesettingPorts = {
    inspectBackground: async () => ({ issues: [], corrections: [] }),
    targetLanguage: "ko",
    signal: new AbortController().signal,
    blockId: (id) => id,
    readPage: async () => [{ view, label: "native source", dataUrl: "source" }],
    cropRegions: async (_pages, readings) =>
      [...readings.values()].flatMap((reading) =>
        reading.regions
          .filter((r) => r.action !== "keep")
          .map((r) => ({ label: r.id, dataUrl: "crop" })),
      ),
    fontSamples: async () => [],
    cleanPage: async (p, reading) => {
      expect(reading.regions.find((r) => r.preserveReason)?.action).not.toBe(
        "text",
      );
      return { page: { ...p, inpaintedImagePath: "clean.png" }, issues: [] };
    },
    illustrate: async (p) => ({ page: p, issues: [] }),
    restoreRegions: async (p, _reading, failed) => {
      restored.push(failed);
      return p;
    },
    render: async () => [{ view, label: "actual render", dataUrl: "render" }],
    saveEvidence: async () => {},
    progress: () => {},
    commit: async (p) => {
      committed.push(p);
    },
    ask: async (stage, _prompt, images) => {
      asks.push(stage);
      if (stage.startsWith("read-"))
        return stage === "read-p1"
          ? { ...partial, regions: onlyUnknown ? [] : [known] }
          : { ...partial, ownedReadability: "readable", unreadableRegions: [] };
      if (stage.startsWith("erase-"))
        return {
          regions: [
            {
              regionId: stage.slice(6) + ":known",
              background: "white",
              reason: "balloon",
              erasePolygons: [
                [
                  { x: 100, y: 100 },
                  { x: 900, y: 100 },
                  { x: 900, y: 900 },
                  { x: 100, y: 900 },
                ],
              ],
            },
          ],
        };
      if (stage === "source-families") {
        expect(images.map((i) => i.label)).toEqual(ids);
        return { groups };
      }
      if (stage === "font-assignment")
        return { fonts: [{ groupId: "family", fontId: "custom" }] };
      if (stage.startsWith("review-")) return { issues: [] };
      if (!stage.startsWith("layout-"))
        throw Error("Unexpected stage: " + stage);
      layouts.push(stage);
      const [, id, attempt] = stage.split("-");
      return {
        layouts: [
          {
            regionId: id + ":known",
            translatedText: "잠깐",
            renderBbox:
              id === "p1" && Number(attempt) < overlapAttempts
                ? protectedBox
                : box,
            fontSizePx: 24,
            lineHeight: 1.2,
            rotationDeg: 0,
            outlineWidthPx: 0,
            textColor: "#000000",
            outlineColor: "#ffffff",
            textAlign: "center",
            direction: "horizontal",
          },
        ],
      };
    },
  };
  return { pages, ports, committed, restored, asks, layouts };
}

describe("localized unreadable source preservation", () => {
  it("keeps known translation separate from an unguessed protected source region", () => {
    const reading = qualifyJapaneseReading(partial, "p1");
    expect(reading.regions[0]).toMatchObject({
      id: "p1:known",
      action: "text",
      sourceText: "待って",
    });
    expect(reading.regions[1]).toMatchObject({
      id: "p1:unknown",
      action: "keep",
      sourceText: "",
      translatedText: "",
      sourceBbox: protectedBox,
      preserveReason: partial.unreadableRegions[0].reason,
    });
  });

  it.each([
    { ...partial, ownedReadability: "readable" },
    { ...partial, unreadableRegions: [] },
    {
      ...partial,
      unreadableRegions: [{ ...partial.unreadableRegions[0], id: "known" }],
    },
    {
      ...partial,
      unreadableRegions: [{ ...partial.unreadableRegions[0], reason: "" }],
    },
    {
      ...partial,
      unreadableRegions: [
        {
          ...partial.unreadableRegions[0],
          sourceBbox: { ...protectedBox, x: 950 },
        },
      ],
    },
    { ...partial, ownedReadability: "unreadable" },
  ])("rejects contradictory or unsafe partial readings %#", (value) => {
    expect(() => qualifyJapaneseReading(value, "p1")).toThrow();
  });

  it.each([
    { x: 651, y: 0, w: 349, h: 1000 },
    { x: 0, y: 351, w: 1000, h: 649 },
    { x: 0, y: 0, w: 650, h: 1000 },
    { x: 0, y: 0, w: 1000, h: 350 },
  ])("rejects unreadable centers outside disjoint ownership %#", (owned) => {
    expect(() => qualifyJapaneseReading(partial, "p1", owned)).toThrow(
      "담당 범위 밖",
    );
  });

  it("finishes other regions and pages while saving a review-only marker", async () => {
    const h = harness();
    const result = await runCodexTypesetting(h.pages, options, h.ports);
    expect(h.committed).toHaveLength(2);
    expect(h.layouts).toEqual(["layout-p1-0", "layout-p2-0"]);
    expect(h.restored).toEqual([]);
    expect(result.pages[0].blocks.map((b) => b.id)).toEqual([
      "p1:known",
      "p1:unknown",
    ]);
    expect(result.pages[0].blocks[1]).toMatchObject({
      translatedText: "",
      sourceText: "",
      textOpacity: 0,
      opacity: 0,
      inpaintExcluded: true,
      reviewStatus: "needs_review",
      bbox: protectedBox,
    });
    expect(result.pages[1].blocks).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });

  it("keeps an entirely localized-unreadable page visible for review without erasure or font calls", async () => {
    const h = harness(0, true);
    const result = await runCodexTypesetting(h.pages, options, h.ports);
    expect(h.asks).toEqual(["read-p1"]);
    expect(result.pages[0].inpaintedImagePath).toBeUndefined();
    expect(result.pages[0].blocks[0].reviewStatus).toBe("needs_review");
    expect(result.warnings).toHaveLength(1);
  });

  it("keeps the first overlapping translation visible with a review marker", async () => {
    const h = harness(1);
    const result = await runCodexTypesetting(h.pages, options, h.ports);
    expect(h.layouts).toEqual(["layout-p1-0", "layout-p2-0"]);
    expect(result.pages[0].blocks[0].renderBbox).toEqual(protectedBox);
    expect(result.pages[0].blocks[0].reviewStatus).toBe("needs_review");
    expect(h.restored).toEqual([]);
  });

  it("does not regenerate or hide an intruding translation and finishes the next page", async () => {
    const h = harness(3);
    const result = await runCodexTypesetting(h.pages, options, h.ports);
    expect(h.layouts).toEqual(["layout-p1-0", "layout-p2-0"]);
    expect(h.restored).toEqual([]);
    expect(
      result.pages[0].blocks.every((b) => b.reviewStatus === "needs_review"),
    ).toBe(true);
    expect(result.pages[1].blocks[0].textOpacity).not.toBe(0);
  });

  it("allows source-box padding overlap but detects a planned destination without a stored block", () => {
    const reading = qualifyJapaneseReading(partial, "p1");
    reading.regions[0].sourceBbox = protectedBox;
    expect(
      preservedReadingConflicts(reading, page, (id) => id).map(
        (i) => i.regionId,
      ),
    ).toEqual([]);
    reading.regions[0].sourceBbox = box;
    reading.regions[0].renderBbox = protectedBox;
    expect(preservedReadingConflicts(reading, page, (id) => id)).toHaveLength(
      1,
    );
    const empty = { page };
    expect(
      withCodexReadingReview(empty, { summary: "", regions: [] }, (id) => id),
    ).toBe(empty);
  });

  it("does not turn a global unlocalized failure into successful empty output", async () => {
    const h = harness();
    h.ports.ask = vi.fn(async () => ({
      ...partial,
      ownedReadability: "unreadable",
      unreadableRegions: [],
      regions: [],
    }));
    await expect(
      runCodexTypesetting(h.pages, options, h.ports),
    ).rejects.toThrow("판독 불가");
    expect(h.committed).toEqual([]);
  });

  it.each(["painted overlap", "renderer overflow"])(
    "marks %s despite an empty model review and keeps the first result visible",
    async (failure) => {
      const h = harness();
      const bounds = { x: 0, y: 0, w: 1000, h: 1000 };
      h.ports.render = async (proposed) => [
        {
          label: "actual renderer",
          dataUrl: "render",
          view: { bounds, ownership: bounds },
          measurements: proposed.blocks.map((block) => ({
            regionId: block.id,
            lines: ["잠깐"],
            fontSizePx: 24,
            innerWidth: 100,
            innerHeight: 100,
            overflow: proposed.id === "p1" && failure === "renderer overflow",
            paintedBounds:
              proposed.id === "p1" && failure === "painted overlap"
                ? protectedBox
                : box,
          })),
        },
      ];
      const result = await runCodexTypesetting(h.pages, options, h.ports);
      expect(
        h.layouts.filter((stage) => stage.startsWith("layout-p1")),
      ).toHaveLength(1);
      expect(
        h.layouts.filter((stage) => stage.startsWith("layout-p2")),
      ).toHaveLength(1);
      expect(h.restored).toEqual([]);
      expect(
        result.pages[0].blocks.find((block) => block.id === "p1:known")
          ?.textOpacity,
      ).not.toBe(0);
      expect(result.pages[1].blocks[0].textOpacity).not.toBe(0);
    },
  );

  it("reports an unresolved erasure after one attempt without restoring or retrying", async () => {
    const h = harness(),
      ask = h.ports.ask,
      clean = h.ports.cleanPage;
    let firstPageCleanCalls = 0;
    h.ports.ask = async (...args) =>
      args[0] === "erase-p1"
        ? {
            regions: [
              {
                regionId: "p1:known",
                erasePolygons: [],
                background: "white",
                reason: "protected source conflict",
              },
            ],
          }
        : ask(...args);
    h.ports.cleanPage = async (...args) => {
      const result = await clean(...args);
      if (args[0].id !== "p1") return result;
      firstPageCleanCalls++;
      expect(
        args[1].regions.find((region) => region.id === "p1:known")
          ?.erasePolygons,
      ).toEqual([]);
      return {
        ...result,
        issues: [
          {
            regionId: "p1:known",
            kind: "background",
            reason: "protected source conflict",
          },
        ],
      };
    };
    const result = await runCodexTypesetting(h.pages, options, h.ports);
    expect(firstPageCleanCalls).toBe(1);
    expect(h.restored).toEqual([]);
    expect(
      result.pages[0].blocks.find((block) => block.id === "p1:known")
        ?.reviewStatus,
    ).toBe("needs_review");
    expect(result.pages[1].blocks[0].textOpacity).not.toBe(0);
  });
});

it("carries terminology into every source view and merges memory in the original reading responses", async () => {
  const h = harness();
  const view = (await h.ports.readPage(page))[0];
  const prompts: string[] = [];
  h.ports.translationContext = () => "王女 = 공주";
  h.ports.readPage = async () => [view, view];
  h.ports.ask = async (_stage, prompt) => {
    prompts.push(prompt);
    return {
      ...partial,
      memory: {
        glossary: [{ source: "待って", target: "잠깐", category: "term" }],
        characters: [],
      },
    };
  };
  const reading = await readCodexPage(page, "Prior chapter", h.ports);
  expect(prompts).toHaveLength(2);
  expect(prompts.every((prompt) => prompt.includes("王女 = 공주"))).toBe(true);
  expect(reading.memory?.glossary).toHaveLength(2);
  expect(
    reading.regions
      .filter((region) => region.action !== "keep")
      .map((region) => region.id),
  ).toEqual(["p1-part-1:known", "p1-part-2:known"]);
});
it("does not count a rejected save as a completed page and passes reading memory to the accepted save", async () => {
  const h = harness();
  const remembered: string[] = [];
  const saved: string[] = [];
  h.ports.rememberReading = (p) => {
    remembered.push(p.id);
  };
  h.ports.commit = async (p, reading) => {
    expect(reading?.summary).toContain("Story");
    if (p.id === "p1") return false;
    saved.push(p.id);
    return true;
  };
  const result = await runCodexTypesetting(h.pages, options, h.ports);
  expect(remembered).toEqual(["p1", "p2"]);
  expect(saved).toEqual(["p2"]);
  expect(result.pages.map((p) => p.id)).toEqual(["p2"]);
});

it.each(["text", "image"] as const)(
  "honors explicit %s region output with original erasure disabled",
  async (output) => {
    const h = harness();
    h.ports.eraseOriginal = false;
    h.ports.regionOutput = output;
    const result = await runCodexTypesetting(h.pages, options, h.ports);
    expect(result.pages).toHaveLength(2);
    expect(h.asks.some((stage) => stage.startsWith("erase-"))).toBe(false);
    expect(
      result.pages[0].blocks.find((b) => b.id === "p1:known")?.sourceText,
    ).toBe("待って");
  },
);

it("waits for user text before erasure and does not repeat recognition on confirmation", async () => {
  const h = harness();
  const continueReading = deferredReading();
  const delivered = deferredReading();
  let first = true;
  h.ports.confirmReading = async (reading) => {
    if (!first) return reading;
    first = false;
    delivered.resolve(reading);
    return continueReading.promise;
  };
  const result = runCodexTypesetting(h.pages, options, h.ports);
  const reading = await delivered.promise;
  expect(h.asks).toEqual(["read-p1"]);
  expect(h.committed).toHaveLength(0);
  continueReading.resolve(reading);
  await result;
  expect(h.asks.filter((s) => s === "read-p1")).toHaveLength(1);
  expect(h.committed).toHaveLength(2);
});

function deferredReading() {
  let resolve!: (
    value: import("../src/shared/codexTypesettingTypes").CodexPageReading,
  ) => void;
  const promise = new Promise<
    import("../src/shared/codexTypesettingTypes").CodexPageReading
  >((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
