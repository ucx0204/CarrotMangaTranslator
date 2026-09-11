import {
  McpLibraryReadService,
  type McpLibraryReadPort,
} from "../application/mcpLibraryReadService";
import { McpPagePreviewService } from "../application/mcpPagePreviewService";
import { createMcpReadTools } from "./mcpReadTools";
import { createMcpPagePreviewTool } from "./mcpPagePreviewTool";

type PreviewRenderer = ConstructorParameters<
  typeof McpPagePreviewService
>[0]["renderApprovedPreview"];

/** One composition path for the desktop runtime and behavioral integration tests. */
export function createMcpToolSet(
  library: McpLibraryReadPort,
  renderApprovedPreview?: PreviewRenderer,
  oauth = false,
) {
  const tools = createMcpReadTools(
    new McpLibraryReadService(library),
    renderApprovedPreview !== undefined,
    oauth,
  );
  if (renderApprovedPreview) {
    tools.push(
      createMcpPagePreviewTool(
        new McpPagePreviewService({
          openChapter: library.openChapter,
          renderApprovedPreview,
        }),
      ),
    );
  }
  return tools.map((tool) => ({ ...tool, oauth }));
}
