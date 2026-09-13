import type { McpTool } from "./mcpReadTools";
import type { McpPageEditService } from "../application/mcpPageEditService";
import { createMcpPageEditTools } from "./mcpPageEditTools";
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
  editing?: { service: McpPageEditService; allowEditing: boolean },
  extensions: McpTool[] = [],
) {
  const tools = createMcpReadTools(
    new McpLibraryReadService(library),
    renderApprovedPreview !== undefined,
    oauth,
    {
      readBlocks: !!editing,
      editTranslations: editing?.allowEditing ?? false,
      additionalTools: extensions.map((tool) => tool.name),
    },
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
  if (editing)
    tools.push(
      ...createMcpPageEditTools(editing.service, editing.allowEditing),
    );
  tools.push(...extensions);
  return tools.map((tool) => ({ ...tool, oauth }));
}
