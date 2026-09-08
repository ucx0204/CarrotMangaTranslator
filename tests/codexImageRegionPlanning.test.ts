import { expect, it, vi } from "vitest";
import {
  applyCodexRegionPlan,
  needsCodexRegionPlanning,
} from "../src/main/codexImageRegionPlanning";
import type { CodexPageReading } from "../src/shared/codexTypesettingTypes";
import { makeBlock, makePage } from "./unifiedInpaintingUiFixtures";

vi.mock("electron", () => ({ nativeImage: {} }));
const bbox = { x: 0, y: 0, w: 1000, h: 1000 };
const reading: CodexPageReading = {
  summary: "context",
  regions: [
    {
      id: "parent",
      action: "image",
      sourceText: "source",
      translatedText: "alpha beta",
      sourceBbox: bbox,
      renderBbox: bbox,
      role: "ordinary",
      direction: "horizontal",
      background: "artwork",
      reason: "",
      translationLocked: true,
    },
  ],
};
const parts = [
  {
    parentRegionId: "parent",
    sourceText: "left",
    translatedText: "alpha ",
    sourceBbox: { x: 0, y: 0, w: 300, h: 800 },
    styleGroupId: "ink",
    styleDescription: "observed treatment",
  },
  {
    parentRegionId: "parent",
    sourceText: "right",
    translatedText: "beta",
    sourceBbox: { x: 650, y: 0, w: 300, h: 800 },
    styleGroupId: "ink",
    styleDescription: "observed treatment",
  },
];
it("keeps translation characters and parent ownership while planning separately placeable members", () => {
  const result = applyCodexRegionPlan(reading, { regions: parts });
  expect(result.regions.map((r) => r.translatedText).join("")).toBe(
    reading.regions[0].translatedText,
  );
  expect(result.regions.map((r) => r.id)).toEqual([
    "parent-part-1",
    "parent-part-2",
  ]);
  expect(
    result.regions.every(
      (r) =>
        r.translationLocked &&
        r.parentRegionId === "parent" &&
        r.styleGroupId === "ink",
    ),
  ).toBe(true);
  expect(result.regions[1].renderBbox).toEqual(parts[1].sourceBbox);
  expect(reading.regions).toHaveLength(1);
});
it("retains previously confirmed SFX identities and geometry while sharing only their style group", () => {
  const result = applyCodexRegionPlan(reading, { regions: parts }, false);
  expect(result.regions).toHaveLength(1);
  expect(result.regions[0]).toMatchObject({
    ...reading.regions[0],
    styleGroupId: "ink",
    styleDescription: "observed treatment",
  });
});
it.each(["changed", "missing", "unknown"])(
  "rejects %s text/ownership without partial plans",
  (kind) => {
    const regions = parts.map((part) => ({ ...part }));
    if (kind === "changed") regions[0].translatedText = "changed ";
    if (kind === "missing") regions.pop();
    if (kind === "unknown") regions[0].parentRegionId = "other";
    expect(() => applyCodexRegionPlan(reading, { regions })).toThrow();
  },
);
it("skips planning a compact single region and plans broad or multiple regions", () => {
  const small = {
    ...makePage(),
    width: 240,
    height: 180,
    blocks: [{ ...makeBlock(), bbox }],
  };
  expect(needsCodexRegionPlanning(small)).toBe(false);
  expect(needsCodexRegionPlanning({ ...small, width: 1200, height: 180 })).toBe(
    true,
  );
  expect(
    needsCodexRegionPlanning({ ...small, width: 1200, height: 1600 }),
  ).toBe(true);
  expect(
    needsCodexRegionPlanning({ ...small, blocks: [makeBlock(), makeBlock()] }),
  ).toBe(true);
});
