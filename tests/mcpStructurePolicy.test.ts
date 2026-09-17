import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planMcpStructure } from "../src/main/application/mcpStructurePolicy";
import { structureFixture } from "./mcpStructure.fixture";

describe("MCP ordinary block structure policy", () => {
  it("deletes one object and leaves the input untouched", () => {
    const f = structureFixture();
    const page = f.chapter.pages[0];
    const original = structuredClone(page);
    const plan = planMcpStructure(page, f.request, randomUUID);
    expect(plan.after.blocks).toEqual([page.blocks[1]]);
    expect(plan.after.blockOrder).toEqual(["b"]);
    expect(plan.before.blocks).toEqual(page.blocks);
    expect(page).toEqual(original);
    expect(JSON.stringify(plan.beforeView)).not.toContain("/private/");
    expect(plan.idMapping).toEqual([{ from: "a", to: [] }]);
  });
  it("splits Unicode text, retains scalar style and inserts children in effective order", () => {
    const f = structureFixture();
    const page = f.chapter.pages[0];
    page.blocks[0].sourceText = "first second";
    page.blocks[0].translatedText = "\uccab\uc9f8 \ub458\uc9f8";
    f.request.operation = {
      kind: "split",
      blockId: "a",
      textPolicy: "preserve",
      parts: [
        {
          ...f.part,
          sourceText: "first",
          translatedText: "\uccab\uc9f8",
          sourceRect: { x: 10.25, y: 20.5, w: 42.5, h: 120 },
        },
        { ...f.part, sourceText: "second", translatedText: "\ub458\uc9f8" },
      ],
    };
    const plan = planMcpStructure(page, f.request, randomUUID);
    const ids = plan.afterView.map((block) => block.id);
    expect(new Set(ids).size).toBe(2);
    expect(plan.after.blockOrder).toEqual(["b", ...ids]);
    expect(plan.after.blocks[2]).toEqual(page.blocks[1]);
    expect(plan.afterView[0].sourceRect).toEqual(
      f.request.operation.parts[0].sourceRect,
    );
    expect(plan.afterView[0].fields.fontFamily).toBe("local-font");
    expect(plan.afterView[0].fields.reviewStatus).toBe("needs_review");
  });
  it("merges adjacent blocks in supplied text order using the explicitly selected style", () => {
    const f = structureFixture();
    const page = f.chapter.pages[0];
    f.request.operation = {
      kind: "merge",
      blockIds: ["b", "a"],
      styleFromBlockId: "b",
      textPolicy: "preserve",
      result: {
        ...f.part,
        sourceText: "source source",
        translatedText: "original-b original-a",
      },
    };
    const plan = planMcpStructure(page, f.request, randomUUID);
    expect(plan.after.blocks).toHaveLength(1);
    expect(plan.afterView[0].translatedText).toBe("original-b original-a");
    expect(plan.after.blockOrder).toEqual([plan.after.blocks[0].id]);
    expect(plan.idMapping).toHaveLength(2);
  });
  it.each([
    "generatedLettering",
    "bubbleLayout",
    "perspectiveTransform",
    "curveLayout",
    "warpTransform",
    "sourceFontFacePx",
  ] as const)("refuses unsafe %s instead of stripping it", (field) => {
    const f = structureFixture();
    Object.assign(f.chapter.pages[0].blocks[0], { [field]: {} });
    expect(() =>
      planMcpStructure(f.chapter.pages[0], f.request, randomUUID),
    ).toThrow(/cannot safely transfer/);
  });
  it("refuses an existing sound-effect reference", () => {
    const f = structureFixture();
    f.chapter.pages[0].soundEffectReview = {
      contractVersion: 3,
      producer: "hayai-regions-v1",
      regions: [],
      regionOverrides: [],
      manualRegions: [],
      resolvedRegions: [{ regionId: "r", blockId: "a", resolvedAt: "now" }],
    };
    expect(() =>
      planMcpStructure(f.chapter.pages[0], f.request, randomUUID),
    ).toThrow(/ledger/);
  });
  it.each([
    { x: -1, y: 0, w: 5, h: 5 },
    { x: 0, y: 0, w: 0, h: 5 },
    { x: 999, y: 0, w: 2, h: 5 },
    { x: 0, y: 0, w: 0.01, h: 5 },
    { x: 0, y: 0, w: Infinity, h: 5 },
  ])("refuses invalid or silently clipped rectangles %j", (rect) => {
    const f = structureFixture();
    f.request.operation = {
      kind: "split",
      blockId: "a",
      textPolicy: "replace",
      parts: [{ ...f.part, sourceRect: rect }, f.part],
    };
    expect(() =>
      planMcpStructure(f.chapter.pages[0], f.request, randomUUID),
    ).toThrow();
  });
  it("does not treat loss of an internal word space as a structure-only edit", () => {
    const f = structureFixture();
    f.chapter.pages[0].blocks[0].sourceText = "hello world";
    f.request.operation = {
      kind: "split",
      blockId: "a",
      textPolicy: "preserve",
      parts: [
        { ...f.part, sourceText: "helloworld" },
        { ...f.part, sourceText: "", translatedText: "" },
      ],
    };
    expect(() =>
      planMcpStructure(f.chapter.pages[0], f.request, randomUUID),
    ).toThrow(/rewrite text/);
    f.request.operation.textPolicy = "replace";
    expect(
      planMcpStructure(f.chapter.pages[0], f.request, randomUUID).warnings,
    ).toContain("explicit_text_replacement");
  });
  it("refuses missing/duplicate IDs and non-adjacent merge targets", () => {
    const f = structureFixture();
    const page = f.chapter.pages[0];
    expect(() =>
      planMcpStructure(
        page,
        { ...f.request, operation: { kind: "delete", blockId: "missing" } },
        randomUUID,
      ),
    ).toThrow(/no longer/);
    page.blocks.push({ ...page.blocks[1], id: "c" });
    page.blockOrder = ["a", "c", "b"];
    f.request.operation = {
      kind: "merge",
      blockIds: ["a", "b"],
      styleFromBlockId: "a",
      result: f.part,
      textPolicy: "replace",
    };
    expect(() => planMcpStructure(page, f.request, randomUUID)).toThrow(
      /adjacent/,
    );
    page.blocks.push(page.blocks[0]);
    expect(() => planMcpStructure(page, f.request, randomUUID)).toThrow(
      /Duplicate/,
    );
  });
  it("deleting the last block keeps an explicit empty order", () => {
    const f = structureFixture();
    f.chapter.pages[0].blocks.splice(1);
    expect(
      planMcpStructure(f.chapter.pages[0], f.request, randomUUID).after,
    ).toEqual({ blocks: [], blockOrder: [] });
  });
});
