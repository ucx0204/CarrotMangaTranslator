import type { ChapterSnapshot, MangaPage } from "../../src/shared/libraryTypes";
import type { TranslationBlock } from "../../src/shared/textTypes";

export function clipboardBlock(id = "lettering"): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox: { x: 100, y: 200, w: 240, h: 160 },
    bboxSpace: "normalized_1000",
    sourceText: "ドン",
    translatedText: "쾅!",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 64,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 0.7,
    fontWeight: 700,
    autoFitText: false,
    generatedLettering: {
      version: 1,
      sourceText: "ドン",
      translatedText: "쾅!",
      dataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=",
      maskStrokes: [
        {
          space: "asset",
          mode: "hide",
          shape: "circle",
          points: [{ x: 50, y: 80 }],
          radiusX: 20,
          radiusY: 30,
          softness: 0.2,
        },
        {
          space: "page",
          mode: "hide",
          shape: "square",
          points: [{ x: 220, y: 280 }],
          radiusX: 10,
          radiusY: 15,
          softness: 0,
        },
      ],
      occlusionPolygons: [
        [
          { x: 100, y: 200 },
          { x: 110, y: 200 },
          { x: 100, y: 210 },
        ],
      ],
    },
  };
}

export function clipboardChapter(
  blocks: TranslationBlock[] = [clipboardBlock()],
  ids = {
    workId: "source-work",
    chapterId: "source-chapter",
    pageId: "source-page",
  },
): ChapterSnapshot {
  const timestamp = "2026-09-12T00:00:00.000Z";
  const page: MangaPage = {
    id: ids.pageId,
    name: "page.png",
    imagePath: "C:/fixture/page.png",
    dataUrl: "",
    width: 1200,
    height: 1800,
    blocks,
    blockOrder: blocks.map((block) => block.id),
    analysisStatus: "completed",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    id: ids.chapterId,
    workId: ids.workId,
    title: "Clipboard fixture",
    sourceKind: "images",
    status: "completed",
    pageOrder: [page.id],
    pages: [page],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
