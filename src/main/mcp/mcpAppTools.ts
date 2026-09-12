import { McpReadingService } from "../application/mcpReadingService";
import { createMcpReadingTool } from "./mcpReadingTool";
import { getAppSettings } from "../settingsStore";
import { getAppPaths } from "../appPaths";
import { McpWorkContextService } from "../application/mcpWorkContextService";
import { McpPageImageService } from "../application/mcpPageImageService";
import { createMcpWorkContextTool } from "./mcpWorkContextTool";
import { createMcpPageImageTools } from "./mcpPageImageTools";
import { cropMcpPage, renderMcpSavedPage } from "./mcpPageImageAdapter";
import type { McpPreferences } from "../../shared/mcpDesktopTypes";
import {
  listLibrary,
  openChapter,
  savePageBlocks,
  resolveWorkContextForChapter,
} from "../library";
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
  const extensions = [
    createMcpWorkContextTool(
      new McpWorkContextService(resolveWorkContextForChapter),
    ),
  ];
  if (options.preferences.allowProcessing)
    extensions.push(
      createMcpReadingTool(
        new McpReadingService({
          openChapter,
          savePageBlocks,
          assertWritable: options.assertWritable,
          notifySaved: options.notifySaved,
          defaults: async () =>
            (await getAppSettings(getAppPaths())).blockFormatDefaults,
        }),
      ),
    );
  if (options.preferences.allowImages)
    extensions.push(
      ...createMcpPageImageTools(
        new McpPageImageService({
          openChapter,
          crop: cropMcpPage,
          render: renderMcpSavedPage,
        }),
      ),
    );
  return createMcpToolSet(
    { listLibrary, openChapter },
    options.preferences.allowImages ? renderMcpPagePreview : undefined,
    true,
    { service: edits, allowEditing: options.preferences.allowEditing },
    extensions,
  ).map((tool) => ({
    ...tool,
    requiredScopes:
      tool.name === "carrot_get_page_preview"
        ? ["carrot.read", "carrot.images"]
        : (tool.requiredScopes ?? ["carrot.read"]),
  }));
}
