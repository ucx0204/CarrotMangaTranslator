import { describe, expect, it, vi } from "vitest";
import {
  codexBatchImages,
  partitionCodexReading,
  assignCodexBatchViews,
} from "../src/main/application/codexTypesettingBatches";
import {
  planCodexPageLayouts,
  reviewCodexPageBatches,
} from "../src/main/application/codexTypesettingPlanning";
import { runCodexTypesetting } from "../src/main/application/codexTypesettingService";
import { applyCodexLayoutTreatment } from "../src/main/application/codexTypesettingTreatment";
import type {
  CodexTypesettingPorts,
  TypesettingLayout,
} from "../src/main/application/codexTypesettingContracts";
import type {
  CodexPageReading,
  CodexPageRegion,
} from "../src/shared/codexTypesettingTypes";
import { createCodexPageViews } from "../src/shared/codexTypesettingViews";
import type { MangaPage } from "../src/shared/libraryTypes";

const page: MangaPage = {
  id: "p",
  name: "long.png",
  imagePath: "original.png",
  dataUrl: "",
  width: 836,
  height: 33264,
  blocks: [],
  analysisStatus: "idle",
  createdAt: "",
  updatedAt: "",
};
const active = Array.from(
  { length: 33 },
  (_, index): CodexPageRegion => ({
    id: `r${index}`,
    action: "text",
    sourceText: "待って",
    translatedText: "잠깐",
    sourceBbox: { x: 100, y: 10 + index * 28, w: 80, h: 8 },
    renderBbox: { x: 100, y: 10 + index * 28, w: 150, h: 8 },
    role: "ordinary",
    direction: "vertical",
    background: "white",
    reason: "dialogue",
  }),
);
const keep: CodexPageRegion = {
  ...active[0],
  id: "keep",
  action: "keep",
  sourceText: "97",
  translatedText: "97",
  sourceBbox: { x: 800, y: 10, w: 30, h: 8 },
  renderBbox: { x: 800, y: 10, w: 30, h: 8 },
};
const reading: CodexPageReading = {
  summary: "chapter context",
  regions: [...active, keep],
};
const source = createCodexPageViews(page).map((view, index) => ({
  view,
  label: `source-${index}`,
  dataUrl: `pixels-${index}`,
}));
const preview = source.map((image) => ({
  ...image,
  label: image.label.replace("source", "preview"),
}));
const plan = {
  groups: [
    {
      id: "family",
      description: "consistent",
      members: active.map((region) => ({
        regionId: region.id,
        bold: false,
        italic: false,
      })),
    },
  ],
  fonts: [{ groupId: "family", fontId: "custom" }],
};
const layout = (region: CodexPageRegion): TypesettingLayout => ({
  regionId: region.id,
  translatedText: region.translatedText,
  renderBbox: region.renderBbox,
  fontSizePx: 30,
  lineHeight: 1.2,
  rotationDeg: 0,
  outlineWidthPx: 0,
  textColor: "#000000",
  outlineColor: "#ffffff",
  textAlign: "center",
  direction: "horizontal",
});
const options = {
  version: 1 as const,
  preset: {
    id: "p",
    name: "custom",
    fonts: [{ fontId: "custom", purpose: "same family" }],
  },
};

function makePorts() {
  const controller = new AbortController();
  const whole = {
    bounds: { x: 0, y: 0, w: page.width, h: page.height },
    ownership: { x: 0, y: 0, w: page.width, h: page.height },
  };
  const ports: CodexTypesettingPorts = {
    targetLanguage: "ko",
    signal: controller.signal,
    blockId: (id) => id,
    readPage: async () => [
      { view: whole, label: "whole fixture", dataUrl: "original" },
    ],
    cropRegions: vi.fn(
      async (_pages: MangaPage[], readings: Map<string, CodexPageReading>) =>
        [...readings.values()].flatMap((current) =>
          current.regions
            .filter((region) => region.action !== "keep")
            .map((region) => ({ label: region.id, dataUrl: "crop" })),
        ),
    ),
    fontSamples: async () => [{ label: "custom", dataUrl: "actual-font" }],
    cleanPage: async (original) => ({
      page: { ...original, inpaintedImagePath: "clean.png" },
      issues: [],
    }),
    inspectBackground: async () => ({ issues: [], corrections: [] }),
    illustrate: async (proposed) => ({ page: proposed, issues: [] }),
    restoreRegions: async (proposed) => proposed,
    render: async () => preview,
    commit: vi.fn(async () => true),
    saveEvidence: vi.fn(async () => {}),
    progress: vi.fn(),
    ask: vi.fn(async (stage, prompt) => {
      if (stage.startsWith("read-"))
        return {
          unreadableRegions: [],
          ownedReadability: "readable",
          contextReadability: "absent",
          readabilityReason: "",
          ...reading,
        };
      if (stage.startsWith("erase-")) {
        const targets = JSON.parse(prompt.split("Requested targets: ")[1]) as {
          id: string;
        }[];
        return {
          regions: targets.map(({ id }) => ({
            regionId: id,
            background: "white",
            reason: "plain",
            erasePolygons: [
              [
                { x: 300, y: 300 },
                { x: 700, y: 300 },
                { x: 700, y: 700 },
                { x: 300, y: 700 },
              ],
            ],
          })),
        };
      }
      if (stage === "source-families")
        return {
          groups: [
            {
              ...plan.groups[0],
              members: active.map((region) => ({
                regionId: `p:${region.id}`,
                bold: false,
                italic: false,
              })),
            },
          ],
        };
      if (stage === "font-assignment") return { fonts: plan.fonts };
      if (stage.startsWith("layout-")) {
        const current = JSON.parse(
          prompt.split("Page content: ")[1].split("\nFrozen chapter style:")[0],
        ) as CodexPageReading;
        return {
          layouts: current.regions
            .filter((region) => region.action !== "keep")
            .map(layout),
        };
      }
      if (stage.startsWith("review-")) return { issues: [] };
      throw Error(`Unexpected stage ${stage}`);
    }),
  };
  return { ports, controller };
}

describe("bounded whole-chapter requests", () => {
  it("sends only requested production measurements without changing images or stored evidence", () => {
    const measurements = active.map((region) => ({
      regionId: region.id,
      lines: [region.translatedText],
      fontSizePx: 30,
      innerWidth: 100,
      innerHeight: 50,
      overflow: false,
    }));
    const image = { ...preview[0], measurements };
    const batch = partitionCodexReading(reading, 16)[0];
    const result = codexBatchImages([source[0], image], batch);
    expect(result[0]).toBe(source[0]);
    expect(result[1].dataUrl).toBe(image.dataUrl);
    expect(result[1].view).toBe(image.view);
    expect(result[1].measurements).toBe(measurements);
    const sent = JSON.parse(result[1].label.split("requested regions: ")[1]);
    expect(sent.map((item: { regionId: string }) => item.regionId)).toEqual(
      active.slice(0, 16).map((region) => region.id),
    );
    expect(image.label).not.toContain("production text layout");
    expect(codexBatchImages([], batch)).toEqual([]);
  });

  it("partitions 280 Japanese regions exactly once while retaining protected context", () => {
    const large = {
      ...reading,
      regions: [
        ...Array.from({ length: 280 }, (_, index) => ({
          ...active[0],
          id: String(index),
        })),
        keep,
      ],
    };
    const batches = partitionCodexReading(large, 12);
    expect(batches).toHaveLength(24);
    expect(
      batches.every(
        (batch) =>
          batch.summary === reading.summary && batch.regions.includes(keep),
      ),
    ).toBe(true);
    expect(
      batches.flatMap((batch) =>
        batch.regions
          .filter((region) => region.action !== "keep")
          .map((region) => region.id),
      ),
    ).toEqual(Array.from({ length: 280 }, (_, index) => String(index)));
    expect(partitionCodexReading({ ...reading, regions: [keep] }, 12)).toEqual(
      [],
    );
    expect(() => partitionCodexReading(reading, 0)).toThrow("batch size");
  });

  it("covers all 22 native views, undetected gaps and both source and moved destination", () => {
    const sparse = {
      ...reading,
      regions: [
        active[0],
        { ...active[32], renderBbox: { x: 800, y: 490, w: 100, h: 20 } },
      ],
    };
    const batches = partitionCodexReading(sparse, 1);
    const assigned = assignCodexBatchViews(page, batches, source);
    expect(new Set(assigned.flat()).size).toBe(source.length);
    expect(assigned[0]).toContain(source[0]);
    expect(assigned[1]).toContain(source[10]);
    expect(() => assignCodexBatchViews(page, batches, [])).toThrow(
      "native views",
    );
    expect(() => assignCodexBatchViews(page, [], source)).toThrow(
      "native views",
    );
  });

  it("keeps all crops together for font comparison after bounded erasure and commits only a complete page", async () => {
    const { ports } = makePorts();
    const result = await runCodexTypesetting([page], options, ports);
    expect(result.pages[0].blocks).toHaveLength(33);
    expect(ports.commit).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(ports.ask).mock.calls;
    const erasures = calls.filter(([stage]) => stage.startsWith("erase-"));
    expect(erasures.map((call) => call[2].length)).toEqual([12, 12, 9]);
    expect(
      calls.find(([stage]) => stage === "source-families")?.[2],
    ).toHaveLength(33);
    expect(calls.filter(([stage]) => stage.startsWith("layout-"))).toHaveLength(
      3,
    );
    expect(calls.filter(([stage]) => stage.startsWith("review-"))).toHaveLength(
      3,
    );
    expect(
      calls.findIndex(([stage]) => stage === "source-families"),
    ).toBeGreaterThan(
      calls.findIndex(([stage]) => stage === "erase-p-batch-3"),
    );
  });

  it("rejects a late missing erasure without committing or assigning fonts", async () => {
    const { ports } = makePorts();
    const ask = ports.ask;
    ports.ask = vi.fn(async (stage, prompt, images) =>
      stage === "erase-p-batch-3"
        ? { regions: [] }
        : ask(stage, prompt, images),
    );
    await expect(runCodexTypesetting([page], options, ports)).rejects.toThrow(
      "Erasure batch",
    );
    expect(ports.commit).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(ports.ask)
        .mock.calls.some(([stage]) => stage === "source-families"),
    ).toBe(false);
  });

  it("stops before the next batch after cancellation", async () => {
    const { ports, controller } = makePorts();
    const ask = ports.ask;
    ports.ask = vi.fn(async (stage, prompt, images) => {
      const result = await ask(stage, prompt, images);
      if (stage.startsWith("erase-")) controller.abort();
      return result;
    });
    await expect(runCodexTypesetting([page], options, ports)).rejects.toThrow();
    expect(
      vi
        .mocked(ports.ask)
        .mock.calls.filter(([stage]) => stage.startsWith("erase-")),
    ).toHaveLength(1);
    expect(ports.commit).not.toHaveBeenCalled();
  });

  it("rejects duplicate layout IDs in a batch even if the full page has those IDs", async () => {
    const { ports } = makePorts();
    ports.ask = async () => ({
      layouts: Array.from({ length: 16 }, () => layout(active[0])),
    });
    await expect(
      planCodexPageLayouts(
        page,
        reading,
        plan,
        { source, samples: [], preview },
        {
          attempt: 1,
          issues: [
            {
              regionId: "r0",
              kind: "text",
              reason: "User requested layout correction",
            },
          ],
        },
        ports,
      ),
    ).rejects.toThrow("Layout batch");
  });

  it("rejects review IDs outside the current batch and preserves valid issues", async () => {
    const { ports } = makePorts();
    ports.ask = async () => ({
      issues: [{ regionId: "r32", kind: "text", reason: "wrong batch" }],
    });
    await expect(
      reviewCodexPageBatches(page, reading, source, preview, 0, ports),
    ).rejects.toThrow("unrequested region");
    ports.ask = async (stage) => ({
      issues: stage.endsWith("batch-3")
        ? [{ regionId: "r32", kind: "background", reason: "source fragment" }]
        : [],
    });
    expect(
      await reviewCodexPageBatches(page, reading, source, preview, 1, ports),
    ).toEqual({
      issues: [
        { regionId: "r32", kind: "background", reason: "source fragment" },
      ],
    });
  });

  it("reviews the latest layout destination and wording while retaining source authority", () => {
    const changed = {
      ...layout(active[0]),
      translatedText: "기다려!",
      renderBbox: { x: 700, y: 500, w: 200, h: 10 },
    };
    const result = applyCodexLayoutTreatment(
      { ...reading, regions: [active[0], keep] },
      [changed],
    );
    expect(result.regions[0].renderBbox).toEqual(changed.renderBbox);
    expect(result.regions[0].translatedText).toBe("기다려!");
    expect(result.regions[0].sourceBbox).toBe(active[0].sourceBbox);
    expect(result.regions[1]).toBe(keep);
  });
});

it.each([
  { approved: "고", rewritten: "고오" },
  { approved: "쾅! 쾅!", rewritten: "콰아앙!" },
  { approved: "BOOM", rewritten: "BOOOOM!" },
  { approved: "ドン", rewritten: "ドーン" },
])(
  "preserves arbitrary user-approved text $approved against a model rewrite",
  async ({ approved, rewritten }) => {
    const { ports } = makePorts();
    const locked = {
      ...reading,
      regions: active.slice(0, 3).map((r) => ({
        ...r,
        translationLocked: true,
        translatedText: approved,
      })),
    };
    ports.ask = vi.fn(async () => ({
      layouts: locked.regions.map((r, i) => ({
        ...layout(r),
        translatedText: rewritten,
        runs: [
          { text: i === 0 ? approved : rewritten, bold: false, italic: false },
        ],
      })),
    }));
    const result = await planCodexPageLayouts(
      page,
      locked,
      plan,
      { source, samples: [] },
      { attempt: 0, issues: [] },
      ports,
    );
    expect(result.map((r) => r.translatedText)).toEqual([
      approved,
      approved,
      approved,
    ]);
    expect(result[0].runs).toEqual([
      { text: approved, bold: false, italic: false },
    ]);
    expect(result[1].runs).toBeUndefined();
  },
);
