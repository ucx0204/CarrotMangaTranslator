import type { PageRevision } from "./pageRevisionTypes";

export type McpTranslationPatch = {
  chapterId: string;
  pageId: string;
  revision: PageRevision;
  edits: { blockId: string; translatedText: string }[];
};
export type McpPageChangedEvent = { chapterId: string; pageIds: string[] };
export type McpEditorState = {
  probeId?: number;
  chapterId: string | null;
  dirtyPageIds: string[];
  hasPendingInpaintingMask: boolean;
};
