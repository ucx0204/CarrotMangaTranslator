import { McpTypographyReadService } from "../application/mcpTypographyReadService";
import { createMcpTypographyReadTools } from "./mcpTypographyReadTools";
import { readMcpFontCatalog } from "./mcpFontCatalogAdapter";
import { createMcpTranslationBatchTools } from "./mcpTranslationBatchTools";
import { createMcpFormatBatchTools } from "./mcpFormatBatchTools";
import {
  createMcpFormatBatchPorts,
  createMcpTranslationBatchPorts,
} from "./mcpTranslationBatchAdapter";
import { createMcpReviewTools } from "./mcpReviewTools";
import { McpReadingService } from "../application/mcpReadingService";
import { createMcpReadingTool } from "./mcpReadingTool";
import { getAppSettings } from "../settingsStore";
import { getAppPaths } from "../appPaths";
import { McpWorkContextService } from "../application/mcpWorkContextService";
import { McpPageImageService } from "../application/mcpPageImageService";
import { createMcpWorkContextTool } from "./mcpWorkContextTool";
import { createMcpPageImageTools } from "./mcpPageImageTools";
import { cropMcpPage, renderMcpSavedPage } from "./mcpPageImageAdapter";
import type { McpTool } from "./mcpReadTools";
import type { McpPageEditScope } from "../../shared/mcpEditingTypes";
import type { McpPreferences } from "../../shared/mcpDesktopTypes";
import {
  listLibrary,
  openChapter,
  savePageBlocks,
  readWorkContextForEdit,
} from "../library";
import { McpPageEditService } from "../application/mcpPageEditService";
import { createMcpToolSet } from "./mcpToolSet";
import { renderMcpPagePreview } from "./mcpPreviewImage";

/** Connect tool use cases to the same public library facade and redaction adapter as the app. */
export function createMcpAppTools(options: {
  preferences: McpPreferences;
  additionalTools?: McpTool[];
  wrapTool?: (tool: McpTool) => McpTool;
  withPageEdit?: McpPageEditScope;
  lifetime?: AbortSignal;
  assertWritable: (chapterId: string, pageId: string) => Promise<void>;
  notifySaved: (chapterId: string, pageId: string) => void;
}) {
  const edits = new McpPageEditService({
    openChapter,
    savePageBlocks,
    assertWritable: options.assertWritable,
    withPageEdit: options.withPageEdit,
    notifySaved: options.notifySaved,
  });
  const extensions = [
    ...typographyReadTools(options.additionalTools ?? []),
    ...(options.additionalTools ?? []),
    ...createMcpTranslationBatchTools(
      createMcpTranslationBatchPorts(edits),
      Boolean(
        options.preferences.allowEditing && options.preferences.allowProcessing,
      ),
      options.lifetime,
    ),
    ...createMcpReviewTools({ listLibrary, openChapter }),
    createMcpWorkContextTool(new McpWorkContextService(readWorkContextForEdit)),
  ];
  if (options.preferences.allowEditing && options.preferences.allowProcessing)
    extensions.push(
      ...createMcpFormatBatchTools(
        createMcpFormatBatchPorts(edits),
        options.lifetime,
      ),
    );
  if (options.preferences.allowProcessing)
    extensions.push(
      createMcpReadingTool(
        new McpReadingService({
          openChapter,
          savePageBlocks,
          assertWritable: options.assertWritable,
          withPageEdit: options.withPageEdit,
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
    {
      service: edits,
      allowEditing: options.preferences.allowEditing,
      allowProcessing: options.preferences.allowProcessing,
      lifetime: options.lifetime,
    },
    extensions,
  ).map((tool) => configureMcpTool(tool, options.wrapTool));
}

function typographyReadTools(operations: readonly McpTool[]): McpTool[] {
  return createMcpTypographyReadTools(
    new McpTypographyReadService({
      openChapter,
      readCatalog: readMcpFontCatalog,
      analysisToolAvailable: operations.some(
        (tool) => tool.name === "carrot_run_typography_analysis",
      ),
      sourceSizeToolAvailable: operations.some(
        (tool) => tool.name === "carrot_run_page_source_size",
      ),
    }),
  );
}

function configureMcpTool(
  tool: McpTool,
  wrap?: (tool: McpTool) => McpTool,
): McpTool {
  const scoped: McpTool = {
    ...tool,
    requiredScopes:
      tool.name === "carrot_get_page_preview"
        ? ["carrot.read", "carrot.images"]
        : (tool.requiredScopes ?? ["carrot.read"]),
  };
  return wrap ? wrap(scoped) : scoped;
}
