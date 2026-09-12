import type { McpPreferences } from "../../shared/mcpDesktopTypes";
import { listLibrary, openChapter, savePageBlocks } from "../library";
import { McpPageEditService } from "../application/mcpPageEditService";
import { createMcpToolSet } from "./mcpToolSet";
import { renderMcpPagePreview } from "./mcpPreviewImage";

/** Connect tool use cases to the same public library facade and redaction adapter as the app. */
export function createMcpAppTools(options: {
  preferences: McpPreferences;
  assertWritable: (chapterId: string, pageId: string) => Promise<void>;
  notifySaved: (chapterId: string, pageId: string) => void;
}) {
  const edits = new McpPageEditService({
    openChapter,
    savePageBlocks,
    assertWritable: options.assertWritable,
    notifySaved: options.notifySaved,
  });
  return createMcpToolSet(
    { listLibrary, openChapter },
    options.preferences.allowImages ? renderMcpPagePreview : undefined,
    true,
    { service: edits, allowEditing: options.preferences.allowEditing },
  ).map((tool) => ({
    ...tool,
    requiredScopes:
      tool.name === "carrot_get_page_preview"
        ? ["carrot.read", "carrot.images"]
        : (tool.requiredScopes ?? ["carrot.read"]),
  }));
}
