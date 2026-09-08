import { expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import {
  decodeRegionEditProtection,
  readingEditProtection,
} from "../src/main/regionEditProtection";
import type { CodexPageReading } from "../src/shared/codexTypesettingTypes";
import { mapRegionBlocksToPageBlocks } from "../src/main/regionCrop";
import { makeBlock, makePage } from "./unifiedInpaintingUiFixtures";

vi.mock("electron", () => ({ nativeImage: {} }));

it("separates each region's reference exclusions from the union used to repair the background", () => {
  const png = new PNG({ width: 4, height: 2 });
  png.data.fill(255);
  const union = `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
  png.data.fill(0, 0, 3);
  const scoped = `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
  const reading: CodexPageReading = {
    summary: "",
    regions: [],
    editProtection: {
      strokes: [],
      maskDataUrl: union,
      regions: [{ regionId: "a", maskDataUrl: scoped }],
    },
  };
  const size = { width: 4, height: 2 };
  expect([...(readingEditProtection(reading, size) ?? [])]).toEqual(
    Array(8).fill(0),
  );
  expect([...(readingEditProtection(reading, size, "a") ?? [])]).toEqual([
    255, 0, 0, 0, 0, 0, 0, 0,
  ]);
  expect(readingEditProtection(reading, size, "b")).toBeUndefined();
  const legacy = {
    ...reading,
    editProtection: { strokes: [], maskDataUrl: scoped },
  };
  expect(readingEditProtection(legacy, size, "b")?.[0]).toBe(255);
  const keep: CodexPageReading["regions"][number] = {
    id: "kept",
    action: "keep" as const,
    sourceText: "",
    translatedText: "",
    sourceBbox: { x: 500, y: 0, w: 500, h: 500 },
    renderBbox: { x: 500, y: 0, w: 500, h: 500 },
    role: "sound",
    direction: "horizontal" as const,
    background: "artwork" as const,
    reason: "excluded",
  };
  expect([
    ...(readingEditProtection({ ...reading, regions: [keep] }, size, "b") ??
      []),
  ]).toEqual([0, 0, 255, 255, 0, 0, 255, 255]);
  expect([
    ...(readingEditProtection({ ...reading, regions: [keep] }, size, "a") ??
      []),
  ]).toEqual([255, 0, 255, 255, 0, 0, 255, 255]);
});

it("keeps anti-aliased exclusion edges protected and rejects mismatched rasters before decoding", () => {
  const png = new PNG({ width: 4, height: 2 });
  png.data.fill(255);
  png.data.fill(0, 0, 3);
  png.data[4] = 254;
  const protection = {
    strokes: [],
    maskDataUrl: `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`,
  };
  expect([
    ...(decodeRegionEditProtection(protection, { width: 4, height: 2 }) ?? []),
  ]).toEqual([255, 255, 0, 0, 0, 0, 0, 0]);
  expect(() =>
    decodeRegionEditProtection(protection, { width: 8, height: 2 }),
  ).toThrow("크기");
});

it("maps page-space exclusions back to the original page and leaves asset-space masks intact", () => {
  const stroke = {
    space: "page" as const,
    mode: "hide" as const,
    shape: "circle" as const,
    radiusX: 100,
    radiusY: 200,
    softness: 0,
    points: [{ x: 500, y: 250 }],
  };
  const asset = { ...stroke, space: "asset" as const };
  const page = { ...makePage(), width: 1000, height: 2000 };
  const block = {
    ...makeBlock(),
    generatedLettering: {
      version: 1 as const,
      dataUrl: "data:image/png;base64,AA==",
      sourceText: "source",
      translatedText: "translation",
      maskStrokes: [stroke, asset],
    },
  };
  const mapped = mapRegionBlocksToPageBlocks([block], page, {
    x: 100,
    y: 300,
    w: 400,
    h: 200,
  })[0];
  expect(mapped.generatedLettering?.maskStrokes).toEqual([
    { ...stroke, radiusX: 40, radiusY: 20, points: [{ x: 300, y: 175 }] },
    asset,
  ]);
});
