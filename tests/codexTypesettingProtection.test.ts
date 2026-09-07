import { describe, expect, it } from "vitest";
import {
  failedRegionClosure,
  preservedReadingConflicts,
} from "../src/main/application/codexTypesettingFallback";
import type {
  CodexPageReading,
  CodexPageRegion,
} from "../src/shared/codexTypesettingTypes";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { BBox, TranslationBlock } from "../src/shared/textTypes";
import type { TypesettingPageImage } from "../src/main/application/codexTypesettingContracts";
import { createIdentityWarpTransform } from "../src/shared/warpTransformMath";

const sourceBbox = { x: 100, y: 100, w: 100, h: 100 };
const renderBbox = { x: 300, y: 400, w: 400, h: 100 };
const protectedBox = { x: 511, y: 393, w: 2, h: 2 };
const region: CodexPageRegion = {
  id: "text",
  action: "text",
  sourceText: "かな",
  translatedText: "MM",
  sourceBbox,
  renderBbox,
  role: "ordinary",
  direction: "horizontal",
  background: "white",
  reason: "",
};
const block: TranslationBlock = {
  id: "text",
  type: "nonsolid",
  bbox: sourceBbox,
  renderBbox,
  sourceText: "かな",
  translatedText: "MM",
  confidence: 1,
  sourceDirection: "horizontal",
  renderDirection: "horizontal",
  fontSizePx: 64,
  lineHeight: 1.2,
  textAlign: "center",
  textColor: "#000000",
  backgroundColor: "#ffffff",
  opacity: 0,
  rotationDeg: 90,
  outlineWidthPx: 0,
};
const page: MangaPage = {
  id: "p",
  name: "synthetic",
  imagePath: "unused",
  width: 600,
  height: 800,
  dataUrl: "",
  blocks: [block],
  analysisStatus: "completed",
  createdAt: "",
  updatedAt: "",
};
function reading(box = protectedBox): CodexPageReading {
  return {
    summary: "",
    regions: [
      region,
      {
        ...region,
        id: "preserved",
        action: "keep",
        sourceBbox: box,
        renderBbox: box,
      },
    ],
  };
}
function evidence(paintedBounds: BBox | null): TypesettingPageImage[] {
  const bounds = { x: 0, y: 0, w: 600, h: 800 };
  return [
    {
      label: "production pixels",
      dataUrl: "",
      view: { bounds, ownership: bounds },
      measurements: [
        {
          regionId: "text",
          lines: ["MM"],
          fontSizePx: 64,
          innerWidth: 240,
          innerHeight: 80,
          overflow: false,
          paintedBounds,
        },
      ],
    },
  ];
}
const identity = (id: string) => id;

describe("transformed and actually painted source protection", () => {
  it("includes a neighbor touched only by expanded background restoration", () => {
    const first = { ...region, id: "first", background: "artwork" as const };
    const next = {
      ...region,
      id: "neighbor",
      sourceBbox: { x: 210, y: 100, w: 30, h: 100 },
    };
    expect(
      failedRegionClosure(
        { summary: "", regions: [first, next] },
        page,
        ["first"],
        (id) => id,
        [],
        true,
      ),
    ).toEqual(["first", "neighbor"]);
    expect(
      failedRegionClosure(
        { summary: "", regions: [{ ...first, background: "white" }, next] },
        page,
        ["first"],
        (id) => id,
        [],
        true,
      ),
    ).toEqual(["first"]);
  });
  it("detects the production rotation counterexample in non-square pixel space", () => {
    expect(
      preservedReadingConflicts(reading(), page, identity).map(
        (issue) => issue.regionId,
      ),
    ).toEqual(["text"]);
    expect(
      preservedReadingConflicts(
        reading(),
        { ...page, blocks: [{ ...block, rotationDeg: 0 }] },
        identity,
      ),
    ).toEqual([]);
    const failed = reading();
    failed.regions[1].action = "text";
    expect(failedRegionClosure(failed, page, ["preserved"], identity)).toEqual([
      "preserved",
      "text",
    ]);
  });

  it("covers warped bounds while retaining ordinary untransformed parity", () => {
    const warp = createIdentityWarpTransform();
    warp.points = warp.points.map((point) => ({
      x: point.x,
      y: point.y - 0.5,
    }));
    const warpedPage = {
      ...page,
      blocks: [{ ...block, rotationDeg: 0, warpTransform: warp }],
    };
    expect(
      preservedReadingConflicts(reading(), warpedPage, identity),
    ).toHaveLength(1);
    expect(
      preservedReadingConflicts(
        reading({ x: 900, y: 900, w: 20, h: 20 }),
        warpedPage,
        identity,
      ),
    ).toEqual([]);
    expect(
      preservedReadingConflicts(reading(sourceBbox), page, identity),
    ).toEqual([]);
  });

  it("uses rendered ink evidence for curves, outlines, custom glyphs and overflow beyond nominal bounds", () => {
    const normalPage = { ...page, blocks: [{ ...block, rotationDeg: 0 }] };
    expect(
      preservedReadingConflicts(
        reading(),
        normalPage,
        identity,
        evidence(protectedBox),
      ),
    ).toHaveLength(1);
    const failed = reading();
    failed.regions[1].action = "text";
    expect(
      failedRegionClosure(
        failed,
        normalPage,
        ["preserved"],
        identity,
        evidence(protectedBox),
      ),
    ).toEqual(["preserved", "text"]);
  });

  it("distinguishes empty painted output from unavailable evidence without rejecting source-box margins", () => {
    expect(
      preservedReadingConflicts(reading(), page, identity, evidence(null)),
    ).toEqual([]);
    expect(
      preservedReadingConflicts(
        reading(),
        page,
        identity,
        evidence({ x: 800, y: 800, w: 20, h: 20 }),
      ),
    ).toEqual([]);
    expect(
      preservedReadingConflicts(
        reading(sourceBbox),
        page,
        identity,
        evidence(null),
      ),
    ).toEqual([]);
  });

  it("still rejects actual ink in a preserved box and retains source overlap in restoration closure", () => {
    const overlap = reading(sourceBbox);
    expect(
      preservedReadingConflicts(overlap, page, identity, evidence(sourceBbox)),
    ).toHaveLength(1);
    overlap.regions[1].action = "text";
    expect(
      failedRegionClosure(
        overlap,
        page,
        ["preserved"],
        identity,
        evidence(null),
      ),
    ).toEqual(["preserved", "text"]);
  });
});
