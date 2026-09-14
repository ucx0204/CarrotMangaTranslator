import type { MangaPage, ChapterSnapshot } from "../../src/shared/libraryTypes";
import type { TranslationBlock } from "../../src/shared/textTypes";
export function makeChapter(page: MangaPage): ChapterSnapshot {
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "idle",
    pageOrder: [page.id],
    pages: [page],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function makePage({
  additionalBlocks = [],
  blockPatch,
  withBubbleLayout = false,
}: {
  additionalBlocks?: TranslationBlock[];
  blockPatch?: Partial<TranslationBlock>;
  withBubbleLayout?: boolean;
} = {}): MangaPage {
  return {
    id: "page-1",
    name: "page-1.png",
    imagePath: "page-1.png",
    dataUrl: "",
    width: 1000,
    height: 1000,
    blocks: [makeBlock(withBubbleLayout, blockPatch), ...additionalBlocks],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function makeBlock(
  withBubbleLayout = false,
  patch: Partial<TranslationBlock> = {},
): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 100 },
    sourceText: "source",
    translatedText: "translated",
    confidence: 0.9,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    renderBbox: withBubbleLayout
      ? { x: 100, y: 100, w: 200, h: 100 }
      : undefined,
    renderBboxSpace: withBubbleLayout ? "normalized_1000" : undefined,
    bubbleLayout: withBubbleLayout
      ? {
          version: 1,
          direction: "horizontal",
          confidence: 0.97,
          origin: "detected",
          modelId: "comic-rtdetr-v1",
          sourceImageRevision: "revision-1",
          insetRatio: 0,
          regions: [
            {
              spans: [
                {
                  blockStart: 0,
                  blockEnd: 1,
                  inlineStart: 0,
                  inlineEnd: 1,
                },
              ],
            },
          ],
        }
      : undefined,
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
    wordBreak: "keep-all",
    ...patch,
  };
}
