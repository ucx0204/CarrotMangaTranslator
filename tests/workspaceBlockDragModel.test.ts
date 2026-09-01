import { describe, expect, it } from "vitest";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import {
  applyBlockDragResolution,
  applyBlockMoveDelta,
  applyResolvedBlockDrag,
  resolveBlockDrag,
  resolveDragCursor,
} from "../src/renderer/src/hooks/workspaceBlockDragModel";
import type { DragState } from "../src/renderer/src/hooks/workspacePointerGeometry";
import { createIdentityWarpTransform } from "../src/shared/blockTransforms";

describe("workspace block drag model", () => {
  it("keeps the rotation cursor active throughout a rotation drag", () => {
    expect(resolveDragCursor("move")).toBe("grabbing");
    const rotationCursor = resolveDragCursor("rotate");
    expect(rotationCursor).toContain("data:image/svg+xml");
    expect(rotationCursor).toMatch(/^url\(".+"\) 12 12, crosshair$/);
  });

  it("keeps the grabbed resize handle cursor throughout a resize drag", () => {
    expect(resolveDragCursor("resize-n")).toBe("ns-resize");
    expect(resolveDragCursor("resize-s")).toBe("ns-resize");
    expect(resolveDragCursor("resize-e")).toBe("ew-resize");
    expect(resolveDragCursor("resize-w")).toBe("ew-resize");
    expect(resolveDragCursor("resize-ne")).toBe("nesw-resize");
    expect(resolveDragCursor("resize-sw")).toBe("nesw-resize");
    expect(resolveDragCursor("resize-nw")).toBe("nwse-resize");
    expect(resolveDragCursor("resize-se")).toBe("nwse-resize");
    expect(resolveDragCursor("resize")).toBe("nwse-resize");
  });

  it("rejects a perspective edge that crosses the opposite edge", () => {
    const { page, drag } = makeFixture("perspective-top");
    const result = resolveBlockDrag(
      drag,
      { clientX: 0, clientY: 40 },
      { left: 0, top: 0, width: 100, height: 100 },
      page,
    );

    expect(result).toMatchObject({ invalid: true, invalidKind: "perspective" });
  });

  it("rejects the final edge movement that puts the quad fully off-page", () => {
    const { page, drag } = makeFixture("perspective-left");
    const startBlock: TranslationBlock = {
      ...drag.startBlock,
      bbox: { x: 900, y: 100, w: 100, h: 200 },
      renderBbox: { x: 900, y: 100, w: 100, h: 200 },
      renderBboxSpace: "normalized_1000",
      perspectiveTransform: {
        version: 1,
        corners: [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
          { x: 2, y: 1 },
          { x: 0, y: 1 },
        ],
      },
    };
    const result = resolveBlockDrag(
      {
        ...drag,
        startBbox: startBlock.bbox,
        startBlock,
      },
      { clientX: 15, clientY: 0 },
      { left: 0, top: 0, width: 100, height: 100 },
      page,
    );

    expect(result).toMatchObject({ invalid: true, invalidKind: "outside" });
  });

  it("resolves the same preview block that is committed at gesture end", () => {
    const { chapter, page, drag } = makeFixture("rotate");
    const resolution = {
      label: "30°",
      mode: "rotate" as const,
      patch: { rotationDeg: 30 },
    };
    const preview = applyBlockDragResolution(drag.startBlock, page, resolution);
    const changed = applyResolvedBlockDrag(chapter, page, drag, resolution);

    expect(preview.rotationDeg).toBe(30);
    expect(changed.pages[0].blocks[0].rotationDeg).toBe(30);
    expect(changed.pages[0].blocks[0]).toEqual(preview);
  });

  it("repositions a narrow off-page box when rotation would hide it", () => {
    const fixture = makeFixture("rotate");
    const startBlock = {
      ...fixture.block,
      bbox: { x: 100, y: 100, w: 100, h: 10 },
      renderBbox: { x: 992, y: 400, w: 100, h: 10 },
      renderBboxSpace: "normalized_1000" as const,
      rotationDeg: 0,
    };
    const result = resolveBlockDrag(
      {
        ...fixture.drag,
        startBlock,
        startBbox: startBlock.renderBbox,
        startX: 109.2,
        startY: 40.5,
      },
      { clientX: 104.2, clientY: 45.5 },
      { left: 0, top: 0, width: 100, height: 100 },
      fixture.page,
    );

    expect(result?.patch?.rotationDeg).toBe(90);
    expect(result?.bbox).toEqual({ x: 947, y: 400, w: 100, h: 10 });
  });

  it("does not add a bbox patch when rotation remains recoverable", () => {
    const fixture = makeFixture("rotate");
    const result = resolveBlockDrag(
      fixture.drag,
      { clientX: 0, clientY: 0 },
      { left: 0, top: 0, width: 100, height: 100 },
      fixture.page,
    );

    expect(result?.mode).toBe("rotate");
    expect(result && Object.hasOwn(result, "bbox")).toBe(false);
  });

  it("moves an automatic block's render box while preserving its source box", () => {
    const fixture = makeFixture("move");
    const startBlock: TranslationBlock = {
      ...fixture.block,
      bbox: { x: 100, y: 120, w: 200, h: 100 },
      bboxSpace: "normalized_1000",
      renderBbox: { x: 80, y: 90, w: 260, h: 140 },
      renderBboxSpace: "normalized_1000",
    };
    const page = { ...fixture.page, blocks: [startBlock] };
    const chapter = { ...fixture.chapter, pages: [page] };
    const drag: DragState = {
      ...fixture.drag,
      mode: "move",
      startBbox: startBlock.renderBbox as NonNullable<
        TranslationBlock["renderBbox"]
      >,
      startBlock,
    };
    const resolution = resolveBlockDrag(
      drag,
      { clientX: 10, clientY: 20 },
      { left: 0, top: 0, width: 100, height: 100 },
      page,
    );
    if (!resolution) throw new Error("expected a move resolution");

    const preview = applyBlockDragResolution(startBlock, page, resolution);
    const changed = applyResolvedBlockDrag(chapter, page, drag, resolution);

    expect(preview.bbox).toEqual(startBlock.bbox);
    expect(preview.renderBbox).toEqual({ x: 180, y: 290, w: 260, h: 140 });
    expect(changed.pages[0]?.blocks[0]).toEqual(preview);
  });

  it("moves a selected block group by one shared constrained delta", () => {
    const fixture = makeFixture("move");
    const first: TranslationBlock = {
      ...fixture.block,
      bbox: { x: 100, y: 120, w: 200, h: 100 },
      renderBbox: { x: 100, y: 120, w: 200, h: 100 },
      renderBboxSpace: "normalized_1000",
    };
    const second: TranslationBlock = {
      ...fixture.block,
      id: "block-2",
      bbox: { x: 850, y: 300, w: 200, h: 100 },
      renderBbox: { x: 850, y: 300, w: 200, h: 100 },
      renderBboxSpace: "normalized_1000",
    };
    const page = { ...fixture.page, blocks: [first, second] };
    const chapter = { ...fixture.chapter, pages: [page] };
    const drag: DragState = {
      ...fixture.drag,
      startBbox: first.renderBbox as NonNullable<
        TranslationBlock["renderBbox"]
      >,
      startBlock: first,
    };
    const resolution = resolveBlockDrag(
      drag,
      { clientX: 50, clientY: 10 },
      { left: 0, top: 0, width: 100, height: 100 },
      page,
      [first, second],
    );
    if (!resolution?.moveDelta) {
      throw new Error("expected a constrained group move resolution");
    }

    const moveDelta = resolution.moveDelta;
    expect(moveDelta).toEqual({ x: 142, y: 100 });
    const previews = [first, second].map((block) =>
      applyBlockMoveDelta(block, page, moveDelta),
    );
    const changed = applyResolvedBlockDrag(chapter, page, drag, resolution, [
      first,
      second,
    ]);

    expect(changed.pages[0]?.blocks).toEqual(previews);
    expect(changed.pages[0]?.blocks[0]?.bbox).toEqual(first.bbox);
    expect(changed.pages[0]?.blocks[1]?.bbox).toEqual(second.bbox);
    expect(changed.pages[0]?.blocks[0]?.renderBbox).toEqual({
      x: 242,
      y: 220,
      w: 200,
      h: 100,
    });
    expect(changed.pages[0]?.blocks[1]?.renderBbox).toEqual({
      x: 992,
      y: 400,
      w: 200,
      h: 100,
    });
  });

  it("allows a move beyond the page and keeps eight units of the box visible", () => {
    const fixture = makeFixture("move");
    const startBlock = {
      ...fixture.block,
      bbox: { x: 900, y: 100, w: 100, h: 200 },
      renderBbox: { x: 900, y: 100, w: 100, h: 200 },
      renderBboxSpace: "normalized_1000" as const,
    };
    const result = resolveBlockDrag(
      { ...fixture.drag, startBbox: startBlock.renderBbox, startBlock },
      { clientX: 80, clientY: 0 },
      { left: 0, top: 0, width: 100, height: 100 },
      { ...fixture.page, blocks: [startBlock] },
    );

    expect(result?.bbox).toEqual({ x: 992, y: 100, w: 100, h: 200 });
  });

  it("keeps source geometry unchanged when only the render box is resized", () => {
    const fixture = makeFixture("resize-se");
    const block: TranslationBlock = {
      ...fixture.block,
      bbox: { x: 100, y: 120, w: 200, h: 100 },
      renderBbox: { x: 80, y: 90, w: 260, h: 140 },
      renderBboxSpace: "normalized_1000",
    };
    const page = { ...fixture.page, blocks: [block] };
    const changed = applyBlockDragResolution(block, page, {
      bbox: { x: 80, y: 90, w: 320, h: 200 },
      label: "320 × 200px",
      mode: "resize-se",
    });

    expect(changed.bbox).toEqual(block.bbox);
    expect(changed.renderBbox).toEqual({ x: 80, y: 90, w: 320, h: 200 });
  });

  it("rejects a warp drag that folds the mesh", () => {
    const fixture = makeFixture("warp-points-1_5_9_13");
    fixture.drag.startBlock = {
      ...fixture.drag.startBlock,
      warpTransform: createIdentityWarpTransform(3),
    };
    const result = resolveBlockDrag(
      fixture.drag,
      { clientX: -20, clientY: 0 },
      { left: 0, top: 0, width: 100, height: 100 },
      fixture.page,
    );

    expect(result).toMatchObject({ invalid: true, invalidKind: "warp" });
  });

  it("rejects a valid warp translated completely outside the page", () => {
    const fixture = makeFixture(
      `warp-points-${Array.from({ length: 16 }, (_value, index) => index).join("_")}`,
    );
    const block = {
      ...fixture.drag.startBlock,
      bbox: { x: 900, y: 100, w: 100, h: 200 },
      renderBbox: { x: 900, y: 100, w: 100, h: 200 },
      warpTransform: createIdentityWarpTransform(3),
    };
    const result = resolveBlockDrag(
      { ...fixture.drag, startBbox: block.bbox, startBlock: block },
      { clientX: 20, clientY: 0 },
      { left: 0, top: 0, width: 100, height: 100 },
      fixture.page,
    );

    expect(result).toMatchObject({ invalid: true, invalidKind: "outside" });
  });
});

function makeFixture(mode: DragState["mode"]): {
  block: TranslationBlock;
  chapter: ChapterSnapshot;
  drag: DragState;
  page: MangaPage;
} {
  const block = makeBlock();
  const now = "2026-01-01T00:00:00.000Z";
  const page: MangaPage = {
    id: "page-1",
    name: "1.png",
    imagePath: "1.png",
    dataUrl: "data:image/png;base64,",
    width: 1000,
    height: 1000,
    blocks: [block],
    analysisStatus: "completed",
    createdAt: now,
    updatedAt: now,
  };
  return {
    block,
    page,
    drag: {
      mode,
      blockId: block.id,
      startX: 0,
      startY: 0,
      startBbox: block.bbox,
      startBlock: block,
    },
    chapter: {
      id: "chapter-1",
      workId: "work-1",
      title: "test",
      sourceKind: "images",
      status: "idle",
      pageOrder: [page.id],
      pages: [page],
      createdAt: now,
      updatedAt: now,
    },
  };
}

function makeBlock(): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 400, h: 200 },
    sourceText: "source",
    translatedText: "translated",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
    rotationDeg: 0,
    perspectiveTransform: {
      version: 1,
      corners: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
    },
  };
}
