import { describe, expect, it } from "vitest";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import {
  applyBlockDragResolution,
  applyResolvedBlockDrag,
  resolveBlockDrag,
} from "../src/renderer/src/hooks/workspaceBlockDragModel";
import type { DragState } from "../src/renderer/src/hooks/workspacePointerGeometry";

describe("workspace block drag model", () => {
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

  it("moves an automatic block's source and render boxes together in preview and commit", () => {
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

    expect(preview.bbox).toEqual({ x: 200, y: 320, w: 200, h: 100 });
    expect(preview.renderBbox).toEqual({ x: 180, y: 290, w: 260, h: 140 });
    expect(changed.pages[0]?.blocks[0]).toEqual(preview);
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
