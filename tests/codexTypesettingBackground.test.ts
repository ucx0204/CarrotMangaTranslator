import { describe, expect, it, vi } from "vitest";
import { prepareCodexBackground } from "../src/main/application/codexTypesettingBackground";
import { withCodexTypesettingReview } from "../src/main/application/codexTypesettingBlocks";
import { failedRegionClosure } from "../src/main/application/codexTypesettingFallback";
import type {
  CodexTypesettingPorts,
  TypesettingBackgroundReview,
} from "../src/main/application/codexTypesettingContracts";
import type { CodexPageReading } from "../src/shared/codexTypesettingTypes";
import type { MangaPage } from "../src/shared/libraryTypes";

const page: MangaPage = {
  id: "p",
  name: "fixture",
  imagePath: "original.png",
  dataUrl: "",
  width: 1000,
  height: 1000,
  blocks: [],
  analysisStatus: "idle",
  createdAt: "",
  updatedAt: "",
};
function harness() {
  const reading: CodexPageReading = {
    summary: "",
    regions: [100, 700].map((x, index) => ({
      id: String(index),
      action: "image",
      sourceText: "ギロ",
      translatedText: "찌릿",
      sourceBbox: { x, y: 100, w: 100, h: 100 },
      renderBbox: { x: 100, y: 100, w: 100, h: 100 },
      background: "artwork",
      role: "sound",
      direction: "horizontal",
      reason: "effect",
    })),
  };
  const events: string[] = [];
  const abort = new AbortController();
  const cleanPage = vi.fn<CodexTypesettingPorts["cleanPage"]>(
    async (current, selected, repair) => {
      events.push(
        `clean:${repair?.attempt ?? 0}:${selected.regions.map((region) => region.id).join(",")}`,
      );
      return {
        page: { ...current, inpaintedImagePath: "background.png" },
        issues: [],
      };
    },
  );
  const inspectBackground: CodexTypesettingPorts["inspectBackground"] = vi.fn(
    async () => {
      events.push("inspect");
      return { issues: [], corrections: [] };
    },
  );
  const restoreRegions: CodexTypesettingPorts["restoreRegions"] = vi.fn(
    async (current, _reading, ids) => {
      events.push(`restore:${ids.join(",")}`);
      return current;
    },
  );
  const unexpected = vi.fn(async () => {
    throw new Error("Foreground work before background verification");
  });
  const ports: CodexTypesettingPorts = {
    targetLanguage: "ko",
    signal: abort.signal,
    blockId: (id) => id,
    progress: vi.fn(),
    cleanPage,
    inspectBackground,
    restoreRegions,
    saveEvidence: vi.fn(async () => {}),
    readPage: unexpected,
    cropRegions: unexpected,
    fontSamples: unexpected,
    ask: unexpected,
    illustrate: unexpected,
    render: unexpected,
    commit: unexpected,
  };
  return { reading, ports, events, abort, unexpected };
}
const issue = {
  regionId: "0",
  kind: "background" as const,
  reason: "Original remains",
};
function correction(): TypesettingBackgroundReview["corrections"][number] {
  return {
    regionId: "0",
    background: "white",
    reason: "Narrow the deletion to spare the curve",
    erasePolygons: [
      [
        { x: 400, y: 400 },
        { x: 600, y: 400 },
        { x: 600, y: 600 },
        { x: 400, y: 600 },
      ],
    ],
  };
}

describe("single-pass background review", () => {
  it("inspects the first saved result once", async () => {
    const h = harness();
    const result = await prepareCodexBackground(page, h.reading, h.ports);
    expect(h.events).toEqual(["clean:0:0,1", "inspect"]);
    expect(result.failedIds).toEqual([]);
    expect(h.unexpected).not.toHaveBeenCalled();
  });
  it.each(["generation", "inspection", "correction"])(
    "keeps %s findings visible without restoring or regenerating",
    async (kind) => {
      const h = harness();
      const original = h.ports.cleanPage;
      if (kind === "generation")
        h.ports.cleanPage = vi.fn(
          async (...args: Parameters<CodexTypesettingPorts["cleanPage"]>) => ({
            ...(await original(...args)),
            issues: [issue],
          }),
        );
      if (kind !== "generation")
        h.ports.inspectBackground = vi.fn(async () => ({
          issues: kind === "inspection" ? [issue] : [],
          corrections: kind === "correction" ? [correction()] : [],
        }));
      const result = await prepareCodexBackground(page, h.reading, h.ports);
      expect(result.page.inpaintedImagePath).toBe("background.png");
      expect(result.reading).toBe(h.reading);
      expect(result.failedIds).toEqual(["0"]);
      expect(result.issues).toHaveLength(1);
      expect(h.ports.cleanPage).toHaveBeenCalledTimes(1);
      expect(h.ports.inspectBackground).toHaveBeenCalledTimes(1);
      expect(h.ports.restoreRegions).not.toHaveBeenCalled();
    },
  );
  it("does not expand review findings to neighboring regions", async () => {
    const h = harness();
    h.reading.regions[1].sourceBbox = { x: 170, y: 100, w: 100, h: 100 };
    h.ports.inspectBackground = vi.fn(async () => ({
      issues: [issue],
      corrections: [],
    }));
    const result = await prepareCodexBackground(page, h.reading, h.ports);
    expect(result.failedIds).toEqual(["0"]);
    expect(h.ports.cleanPage).toHaveBeenCalledTimes(1);
    expect(failedRegionClosure(h.reading, page, ["0"], (id) => id)).toEqual([
      "0",
      "1",
    ]);
  });
  it("rejects unknown targets and honors cancellation", async () => {
    const h = harness();
    h.ports.inspectBackground = vi.fn(async () => ({
      issues: [{ ...issue, regionId: "unknown" }],
      corrections: [],
    }));
    await expect(
      prepareCodexBackground(page, h.reading, h.ports),
    ).rejects.toThrow("대상 밖");
    h.abort.abort();
    await expect(
      prepareCodexBackground(page, h.reading, h.ports),
    ).rejects.toThrow();
    expect(h.ports.cleanPage).toHaveBeenCalledTimes(1);
  });
  it("keeps generated layers, text opacity and neighbors intact while attaching per-region findings", () => {
    const block = {
      id: "0",
      sourceText: "ギロ",
      translatedText: "찌릿",
      textOpacity: 0.8,
      generatedLettering: {
        version: 1,
        dataUrl: "pixels",
        sourceText: "ギロ",
        translatedText: "찌릿",
      },
    } as MangaPage["blocks"][number];
    const neighbor = { ...block, id: "1" };
    const input = {
      page: {
        ...page,
        inpaintedImagePath: "first.png",
        blocks: [block, neighbor],
        blockOrder: ["0", "1"],
      },
    };
    expect(withCodexTypesettingReview(input, [], (id) => id)).toBe(input);
    const result = withCodexTypesettingReview(input, [issue], (id) => id);
    expect(result.page.inpaintedImagePath).toBe("first.png");
    expect(result.page.blocks[0]).toMatchObject({
      ...block,
      reviewStatus: "needs_review",
      reviewNote: "Original remains",
    });
    expect(result.page.blocks[0].inpaintExcluded).not.toBe(true);
    expect(result.page.blocks[1]).toBe(neighbor);
    expect(result.page.blockOrder).toEqual(["0", "1"]);
    expect(result.warning).toContain("1개");
  });
});

it("preserves generated backgrounds when the review request itself fails", async () => {
  const { reading, ports } = harness();
  vi.mocked(ports.inspectBackground).mockRejectedValueOnce(
    new Error("account disconnected"),
  );
  const result = await prepareCodexBackground(page, reading, ports);
  expect(ports.cleanPage).toHaveBeenCalledOnce();
  expect(ports.inspectBackground).toHaveBeenCalledOnce();
  expect(result.page.inpaintedImagePath).toBeDefined();
  expect(result.failedIds).toEqual(["0", "1"]);
  expect(result.issues[0].reason).toContain("account disconnected");
  expect(ports.restoreRegions).not.toHaveBeenCalled();
});
