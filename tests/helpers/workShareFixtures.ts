import { join } from "node:path";
import type { LibraryChapter } from "../../src/shared/libraryTypes";
export function makeChapter(
  rootDir: string,
  chapterId: string,
  title: string,
  pageId: string,
  blockId: string,
): LibraryChapter {
  return {
    id: chapterId,
    workId: "work-1",
    title,
    sourceKind: "folder",
    status: "completed",
    pageOrder: [pageId],
    pages: [
      {
        id: pageId,
        name: "001.png",
        imagePath: join(
          rootDir,
          "works",
          "work-1",
          "chapters",
          chapterId,
          "pages",
          `001-${pageId}.png`,
        ),
        width: 100,
        height: 120,
        blocks: [
          {
            id: blockId,
            type: "nonsolid",
            bbox: { x: 10, y: 10, w: 100, h: 100 },
            bboxSpace: "normalized_1000",
            sourceText: "こんにちは",
            translatedText: "안녕",
            confidence: 0.95,
            sourceDirection: "vertical",
            renderDirection: "vertical",
            fontSizePx: 18,
            lineHeight: 1.2,
            textAlign: "center",
            textColor: "#111111",
            backgroundColor: "#ffffff",
            opacity: 0.8,
            autoFitText: true,
          },
        ],
        analysisStatus: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
