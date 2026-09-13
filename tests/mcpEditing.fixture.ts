import { vi } from "vitest";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import type { SavePageBlocksRequest } from "../src/shared/shareTypes";
import { createPageRevision } from "../src/shared/pageRevision";
import { McpPageEditService } from "../src/main/application/mcpPageEditService";

function editingBlock(id: string): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox: { x: 10, y: 20, w: 90, h: 120 },
    renderBbox: { x: 15, y: 25, w: 80, h: 110 },
    bboxSpace: "pixels",
    sourceText: "source",
    translatedText: `original-${id}`,
    sourceDirection: "vertical",
    renderDirection: "horizontal",
    textRole: "sound",
    confidence: 1,
    fontFamily: "local-font",
    fontSizePx: 28,
    lineHeight: 1.3,
    textAlign: "center",
    textColor: "#000000",
    backgroundColor: "transparent",
    opacity: 1,
    generatedLettering: {
      version: 1,
      dataUrl: "PRIVATE-GENERATED-BYTES",
      sourceText: "source",
      translatedText: `original-${id}`,
    },
  };
}
export function editingChapter(): ChapterSnapshot {
  return {
    id: "chapter",
    workId: "work",
    title: "Test",
    sourceKind: "images",
    status: "idle",
    pageOrder: ["page"],
    createdAt: "same-time",
    updatedAt: "same-time",
    pages: [
      {
        id: "page",
        name: "page.png",
        width: 1000,
        height: 1600,
        imagePath: "/private/original.png",
        inpaintedImagePath: "/private/clean.png",
        inpaintMaskPath: "/private/mask.png",
        maskProvenance: "derived-diff",
        dataUrl: "PRIVATE-ORIGINAL-BYTES",
        blocks: [editingBlock("a"), editingBlock("b")],
        blockOrder: ["b", "a"],
        analysisStatus: "idle",
        createdAt: "same-time",
        updatedAt: "same-time",
      },
    ],
  };
}
export function editingFixture() {
  const chapter = editingChapter();
  const assertWritable = vi.fn(async () => {});
  const notifySaved = vi.fn();
  const openChapter = vi.fn(async () => structuredClone(chapter));
  const savePageBlocks = vi.fn(
    async (request: SavePageBlocksRequest, assertCanCommit?: () => void) => {
      assertCanCommit?.();
      const page = chapter.pages[0];
      if (request.expectedRevision !== createPageRevision(page))
        throw new Error(
          "페이지가 다른 작업으로 갱신되었습니다. internal path /private/page.json",
        );
      page.blocks = structuredClone(request.blocks);
      page.blockOrder = request.blockOrder;
      return structuredClone(chapter);
    },
  );
  const service = new McpPageEditService({
    openChapter,
    savePageBlocks,
    assertWritable,
    notifySaved,
  });
  const request = {
    chapterId: chapter.id,
    pageId: "page",
    revision: createPageRevision(chapter.pages[0]),
    edits: [{ blockId: "a", translatedText: "수정한 대사" }],
  };
  return {
    chapter,
    assertWritable,
    notifySaved,
    openChapter,
    savePageBlocks,
    service,
    request,
  };
}
