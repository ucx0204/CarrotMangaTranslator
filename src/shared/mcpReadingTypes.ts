import type { PageRevision } from "./pageRevisionTypes";
import type { PixelRect } from "./region";

export type McpReadingBlock = {
  key: string;
  sourceText: string;
  translatedText: string;
  sourceRect: PixelRect;
  renderRect?: PixelRect;
  sourceDirection?: "horizontal" | "vertical";
  renderDirection?: "horizontal" | "vertical";
  textRole?: "ordinary" | "sound";
};
export type McpPageReading = {
  chapterId: string;
  pageId: string;
  revision: PageRevision;
  requestId: string;
  blocks: McpReadingBlock[];
};
