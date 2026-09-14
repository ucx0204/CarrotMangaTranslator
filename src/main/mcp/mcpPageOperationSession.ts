import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { McpPreferences } from "../../shared/mcpDesktopTypes";
import type { PageRevision } from "../../shared/pageRevisionTypes";
import { McpOperationService } from "../application/mcpOperationService";
import { McpPageExportService } from "../application/mcpPageExportService";
import { McpOcrService } from "../application/mcpOcrService";
import { McpReadingService } from "../application/mcpReadingService";
import { McpEditError } from "../application/mcpEditPolicy";
import { openChapter, savePageBlocks } from "../library";
import { getAppSettings } from "../settingsStore";
import { readImageRedactionState } from "../imageRedactionStore";
import { renderMcpPagePng } from "./mcpPageImageAdapter";
import { McpArtifactStore } from "./mcpArtifactStore";
import { createMcpOperationTools } from "./mcpOperationTools";
import { runMcpAppJob } from "./mcpAppJob";
import { eraseMcpPage } from "./mcpErasureAdapter";
import { recognizeMcpPage } from "./mcpOcrAdapter";

type Editing = {
  assertWritable: (chapterId: string, pageId: string) => Promise<void>;
  assertClean: (chapterId: string, pageId: string) => Promise<void>;
  notifySaved: (chapterId: string, pageId: string) => void;
};
/** All heavy work joins the app's existing exclusive job store; only receipts and
 * exported temporary files belong to this MCP connection session. */
export function createMcpPageOperationSession(options: {
  origin: string;
  preferences: McpPreferences;
  app: InpaintingJobContext;
  editing: Editing;
  reportError: (error: unknown) => void;
}) {
  const { app, editing, preferences } = options;
  const operations = new McpOperationService(options.reportError);
  const artifacts = new McpArtifactStore(options.origin);
  const exporter = new McpPageExportService({
    openChapter,
    render: renderMcpPagePng,
    store: artifacts.put.bind(artifacts),
    assertImageAccess: async () => {
      if ((await readImageRedactionState()).enabled)
        throw new McpEditError(
          "access_denied",
          "Rendered image transfer is blocked by redaction review.",
        );
    },
  });
  const reader = new McpReadingService({
    openChapter,
    savePageBlocks,
    assertWritable: editing.assertClean,
    notifySaved: editing.notifySaved,
    defaults: async () =>
      (await getAppSettings(app.appPaths)).blockFormatDefaults,
  });
  const tools = createMcpOperationTools(operations, {
    exportPng: preferences.allowImages
      ? (target, context) =>
          runMcpAppJob(app, context, "page-export", (job) =>
            exporter.export(target, job),
          )
      : undefined,
    ocr: preferences.allowProcessing
      ? async (target, context) => {
          await editing.assertWritable(target.chapterId, target.pageId);
          return runMcpAppJob(app, context, "gemma-analysis", (job, emit) =>
            new McpOcrService({
              openChapter,
              recognize: (page, operation) =>
                recognizeMcpPage(app, target.chapterId, page, operation, emit),
              saveReading: (reading, guard) => reader.create(reading, guard),
            }).run(
              { ...target, revision: target.revision as PageRevision },
              job,
            ),
          );
        }
      : undefined,
    erase: preferences.allowProcessing
      ? (target, context) => eraseMcpPage(app, editing, target, context)
      : undefined,
  });
  return {
    tools,
    artifacts,
    stop: () => {
      operations.stop();
      artifacts.stop();
    },
    close: async () => {
      await operations.close();
      await artifacts.close();
    },
  };
}
