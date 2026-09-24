import type { PageRevision } from "./pageRevisionTypes";

export type McpTranslationPatch = {
  chapterId: string;
  pageId: string;
  revision: PageRevision;
  edits: { blockId: string; translatedText: string }[];
};
export type McpLibraryChangedEvent = { workId: string; chapterId?: string };
export type McpPageChangedEvent = { chapterId: string; pageIds: string[] };
export type McpEditorState = {
  probeId?: number;
  chapterId: string | null;
  dirtyPageIds: string[];
  hasPendingInpaintingMask: boolean;
};

/** Trusted in-process page lease; never accepted from MCP or IPC arguments. */
export type McpPageEditScope = <T>(
  target: { chapterId: string; pageId: string },
  assertAuthorized: () => void,
  execute: (assertAuthorized: () => void) => Promise<T>,
) => Promise<T>;
