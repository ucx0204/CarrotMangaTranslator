import { describe, expect, it, vi } from "vitest";
import {
  createCodexPageViews,
  rebaseCodexViewRegion,
} from "../src/shared/codexTypesettingViews";
import { readCodexPage } from "../src/main/application/codexTypesettingReading";
import { qualifyJapaneseReading } from "../src/main/application/codexTypesettingValidation";
import { runCodexTypesetting } from "../src/main/application/codexTypesettingService";
import type { CodexTypesettingPorts } from "../src/main/application/codexTypesettingContracts";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { CodexPageRegion } from "../src/shared/codexTypesettingTypes";

const region: CodexPageRegion = {
  id: "r1",
  action: "text",
  sourceText: "え？",
  translatedText: "어?",
  sourceBbox: { x: 100, y: 100, w: 100, h: 100 },
  renderBbox: { x: 80, y: 80, w: 150, h: 150 },
  role: "ordinary",
  direction: "vertical",
  background: "white",
  reason: "dialogue",
};
const page: MangaPage = {
  id: "page",
  width: 836,
  height: 33264,
  name: "001.jpeg",
  imagePath: "original.jpeg",
  dataUrl: "",
  blocks: [],
  analysisStatus: "idle",
  createdAt: "",
  updatedAt: "",
};

function readingPorts(
  overrides: Partial<CodexTypesettingPorts>,
): CodexTypesettingPorts {
  const unexpected = async (): Promise<never> => {
    throw new Error(
      "Unexpected composition operation before complete reading.",
    );
  };
  return {
    targetLanguage: "ko",
    signal: new AbortController().signal,
    ask: unexpected,
    readPage: unexpected,
    cropRegions: unexpected,
    fontSamples: unexpected,
    cleanPage: unexpected,
    inspectBackground: unexpected,
    restoreRegions: unexpected,
    illustrate: unexpected,
    render: unexpected,
    saveEvidence: vi.fn(),
    commit: unexpected,
    progress: vi.fn(),
    blockId: (id) => id,
    ...overrides,
  };
}

it("rebases occluder contours with their source region into native page coordinates", () => {
  const mapped = rebaseCodexViewRegion(
    {
      ...region,
      occlusionPolygons: [
        [
          { x: 100, y: 200 },
          { x: 300, y: 200 },
          { x: 300, y: 400 },
        ],
      ],
    },
    {
      bounds: { x: 100, y: 200, w: 400, h: 600 },
      ownership: { x: 100, y: 200, w: 400, h: 600 },
    },
    { width: 1000, height: 2000 },
  );
  expect(mapped?.occlusionPolygons?.[0]).toEqual([
    { x: 140, y: 160 },
    { x: 220, y: 160 },
    { x: 220, y: 220 },
  ]);
});

describe("native page views and explicit readability", () => {
  it.each([
    { width: 836, height: 33264 },
    { width: 33264, height: 836 },
    { width: 4000, height: 5000 },
    { width: 1, height: 1 },
    { width: 2048, height: 2048 },
  ])(
    "covers every native coordinate once while retaining overlap: %j",
    (size) => {
      const views = createCodexPageViews(size);
      const area = views.reduce(
        (sum, { ownership }) => sum + ownership.w * ownership.h,
        0,
      );
      expect(area).toBe(size.width * size.height);
      for (const [i, { bounds, ownership }] of views.entries()) {
        expect(bounds.w).toBeLessThanOrEqual(2048);
        expect(bounds.h).toBeLessThanOrEqual(2048);
        expect(bounds.x).toBeLessThanOrEqual(ownership.x);
        expect(bounds.y).toBeLessThanOrEqual(ownership.y);
        expect(bounds.x + bounds.w).toBeGreaterThanOrEqual(
          ownership.x + ownership.w,
        );
        expect(bounds.y + bounds.h).toBeGreaterThanOrEqual(
          ownership.y + ownership.h,
        );
        for (const other of views.slice(i + 1)) {
          const overlapX =
            Math.min(
              ownership.x + ownership.w,
              other.ownership.x + other.ownership.w,
            ) - Math.max(ownership.x, other.ownership.x);
          const overlapY =
            Math.min(
              ownership.y + ownership.h,
              other.ownership.y + other.ownership.h,
            ) - Math.max(ownership.y, other.ownership.y);
          expect(overlapX <= 0 || overlapY <= 0).toBe(true);
        }
      }
    },
  );

  it.each([0, -1, NaN, Infinity, 1.5, 100001])(
    "rejects unsafe dimension %s",
    (width) => {
      expect(() => createCodexPageViews({ width, height: 2000 })).toThrow();
    },
  );

  it("assigns a border-center phrase once and preserves separate source/render geometry", () => {
    const views = createCodexPageViews(page);
    const y = 1536;
    const results = views.slice(0, 2).map((view) => {
      const localY = ((y - 50 - view.bounds.y) * 1000) / view.bounds.h;
      return rebaseCodexViewRegion(
        {
          ...region,
          sourceBbox: {
            x: 100,
            y: localY,
            w: 100,
            h: (100 * 1000) / view.bounds.h,
          },
        },
        view,
        page,
      );
    });
    expect(results[0]).toBeNull();
    expect(results[1]?.sourceBbox.y).toBeCloseTo(
      ((y - 50) * 1000) / page.height,
      10,
    );
    expect(results[1]?.sourceBbox.h).toBeCloseTo(
      (100 * 1000) / page.height,
      10,
    );
    expect(results[1]?.renderBbox).not.toEqual(results[1]?.sourceBbox);
  });

  it("requires explicit readability and rejects the real empty-unreadable failure", () => {
    expect(() =>
      qualifyJapaneseReading({ summary: "too small", regions: [] }, "page"),
    ).toThrow();
    expect(() =>
      qualifyJapaneseReading(
        {
          unreadableRegions: [],
          ownedReadability: "unreadable",
          contextReadability: "absent",
          readabilityReason: "",
          summary: "축소되어 판독 불가",
          regions: [],
        },
        "page",
      ),
    ).toThrow("판독 불가");
    expect(
      qualifyJapaneseReading(
        {
          unreadableRegions: [],
          ownedReadability: "readable",
          contextReadability: "absent",
          readabilityReason: "",
          summary: "빈 그림",
          regions: [],
        },
        "page",
      ).regions,
    ).toEqual([]);
  });

  it("reads views in order with bounded context and unique rebased region IDs", async () => {
    const images = createCodexPageViews({ width: 836, height: 4000 }).map(
      (view, index) => ({ view, label: String(index), dataUrl: "image" }),
    );
    const ask = vi.fn(async (_stage: string, prompt: string) => {
      if (ask.mock.calls.length > 1) expect(prompt).toContain("previous scene");
      const owned = JSON.parse(
        prompt.split("VIEW-normalized 0..1000: ")[1].slice(0, -1),
      );
      if (ask.mock.calls.length === 1) {
        expect(owned.y).toBe(0);
        expect(owned.h).toBeCloseTo((1536 * 1000) / 1792);
      } else if (ask.mock.calls.length === 2) {
        expect(owned.y).toBe(125);
        expect(owned.h).toBe(750);
      }
      return {
        unreadableRegions: [],
        ownedReadability: "readable",
        contextReadability: "absent",
        readabilityReason: "",
        summary: "previous scene",
        regions: [
          { ...region, sourceBbox: { x: 100, y: 500, w: 100, h: 100 } },
        ],
      };
    });
    const ports = readingPorts({
      readPage: async () => images,
      ask,
      targetLanguage: "ko",
      signal: new AbortController().signal,
      saveEvidence: vi.fn(),
    });
    const reading = await readCodexPage(
      { ...page, height: 4000 },
      "chapter",
      ports,
    );
    expect(ask).toHaveBeenCalledTimes(images.length);
    expect(new Set(reading.regions.map((r) => r.id)).size).toBe(images.length);
    expect(reading.regions.map((r) => r.sourceBbox.y)).toEqual(
      [...reading.regions.map((r) => r.sourceBbox.y)].sort((a, b) => a - b),
    );
    expect(ports.saveEvidence).toHaveBeenCalledTimes(images.length);
  });

  it("separates the real clipped-context failure from unreadable owned lettering", () => {
    const response = {
      unreadableRegions: [],
      ownedReadability: "readable",
      contextReadability: "clipped",
      readabilityReason:
        "담당 구간의 제목과 대사는 읽힘. 담당 밖 하단 효과음은 잘림.",
      summary: "오르카를 부르는 장면",
      regions: [region],
    };
    expect(qualifyJapaneseReading(response, "p").regions).toHaveLength(1);
    expect(() =>
      qualifyJapaneseReading(
        {
          ...response,
          unreadableRegions: [],
          ownedReadability: "unreadable",
          readabilityReason: "담당 구간의 작은 글씨를 읽을 수 없음",
        },
        "p",
      ),
    ).toThrow("담당 구간의 작은 글씨");
    expect(() =>
      qualifyJapaneseReading(
        {
          readability: "unreadable",
          summary: response.readabilityReason,
          regions: [region],
        },
        "p",
      ),
    ).toThrow();
  });

  it("does not commit or erase existing pages when a later view is unreadable", async () => {
    const images = createCodexPageViews(page)
      .slice(0, 2)
      .map((view) => ({ view, label: "source", dataUrl: "image" }));
    const commit = vi.fn();
    const ask = vi
      .fn()
      .mockResolvedValueOnce({
        unreadableRegions: [],
        ownedReadability: "readable",
        contextReadability: "absent",
        readabilityReason: "",
        summary: "ok",
        regions: [],
      })
      .mockResolvedValue({
        unreadableRegions: [],
        ownedReadability: "unreadable",
        contextReadability: "absent",
        readabilityReason: "",
        summary: "clipped",
        regions: [],
      });
    const ports = readingPorts({
      readPage: async () => images,
      ask,
      commit,
      progress: vi.fn(),
      targetLanguage: "ko",
      signal: new AbortController().signal,
      saveEvidence: vi.fn(),
    });
    await expect(
      runCodexTypesetting(
        [page],
        { version: 1, preset: { id: "p", name: "p", fonts: [] } },
        ports,
      ),
    ).rejects.toThrow("clipped");
    expect(commit).not.toHaveBeenCalled();
  });

  it("retains an unreadable excluded logo as protected keep content without coercing failed Japanese readings", () => {
    const response = {
      unreadableRegions: [],
      ownedReadability: "readable",
      contextReadability: "absent",
      readabilityReason: "Japanese readable; excluded English logo too small.",
      summary: "Breakfast scene",
      regions: [
        region,
        {
          ...region,
          id: "logo",
          action: "keep",
          sourceText: "",
          translatedText: "",
        },
        { ...region, id: "number", sourceText: "13", translatedText: "13" },
      ],
    };
    const result = qualifyJapaneseReading(response, "p");
    expect(result.regions.map(({ id, action }) => ({ id, action }))).toEqual([
      { id: "p:r1", action: "text" },
      { id: "p:logo", action: "keep" },
      { id: "p:number", action: "keep" },
    ]);
    expect(result.regions[1].sourceBbox).toEqual(region.sourceBbox);
    expect(() =>
      qualifyJapaneseReading(
        { ...response, ownedReadability: "unreadable" },
        "p",
      ),
    ).toThrow("판독 불가");
  });

  it("rejects absent views and honors cancellation before requesting", async () => {
    const controller = new AbortController();
    const ports = readingPorts({
      signal: controller.signal,
      readPage: async () => [],
      ask: vi.fn(),
    });
    await expect(readCodexPage(page, "", ports)).rejects.toThrow("구간");
    ports.readPage = async () =>
      createCodexPageViews(page).map((view) => ({
        view,
        label: "",
        dataUrl: "",
      }));
    controller.abort();
    await expect(readCodexPage(page, "", ports)).rejects.toThrow();
    expect(ports.ask).not.toHaveBeenCalled();
  });
});
