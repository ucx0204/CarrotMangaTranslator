import { vi } from "vitest";
import type { LibraryIndex } from "../src/shared/libraryTypes";
import { createMcpReviewTools } from "../src/main/mcp/mcpReviewTools";
import { mcpToolResult } from "../src/main/mcp/mcpToolResult";
import { editingChapter } from "./mcpEditing.fixture";

export function reviewToolsFixture() {
  const chapter = editingChapter();
  const openChapter = vi.fn(async () => structuredClone(chapter));
  const listLibrary = vi.fn(
    async (): Promise<LibraryIndex> => ({
      workOrder: [chapter.workId],
      works: [
        {
          id: chapter.workId,
          title: "PRIVATE-TITLE",
          chapterOrder: [chapter.id],
          createdAt: "now",
          updatedAt: "now",
          chapters: [
            {
              id: chapter.id,
              workId: chapter.workId,
              title: chapter.title,
              status: chapter.status,
              pageCount: chapter.pages.length,
              createdAt: "now",
              updatedAt: "now",
            },
          ],
        },
      ],
    }),
  );
  const repository = { openChapter, listLibrary };
  const tools = createMcpReviewTools(repository);
  const call = async (
    index: number,
    args: Record<string, unknown>,
    guard = () => {},
  ) =>
    mcpToolResult(
      tools[index],
      await tools[index].invoke(args, { assertAuthorized: guard }),
    );
  return { chapter, repository, tools, call };
}
