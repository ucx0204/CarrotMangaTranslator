import { createMcpBlockTranslationExecutor } from "./mcpBlockTranslationSession";
import { createMcpBlockOcrExecutor } from "./mcpBlockOcrSession";
import { createMcpErasureRecoverySession } from "./mcpErasureRecoverySession";
import type { McpJobPersistence } from "../application/mcpJobJournal";
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
  jobPersistence?: McpJobPersistence;
  preferences: McpPreferences;
  app: InpaintingJobContext;
  editing: Editing;
  reportError: (error: unknown) => void;
}) {
  const { app, editing, preferences } = options;
  const operations = new McpOperationService(
    options.reportError,
    Date.now,
    options.jobPersistence,
  );
  const recovery = preferences.allowProcessing
    ? createMcpErasureRecoverySession(app, operations, editing.notifySaved)
    : undefined;
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
  const executors: Parameters<typeof createMcpOperationTools>[1] = {
    exportPng: preferences.allowImages
      ? createExportExecutor(app, exporter)
      : undefined,
    ocr: preferences.allowProcessing
      ? createOcrExecutor(app, reader)
      : undefined,
    blockOcr: preferences.allowProcessing
      ? createMcpBlockOcrExecutor(app)
      : undefined,
    blockTranslation: preferences.allowProcessing
      ? createMcpBlockTranslationExecutor(app)
      : undefined,
    erase: preferences.allowProcessing
      ? createErasureExecutor(app, editing, recovery)
      : undefined,
  };
  return {
    tools: [
      ...(recovery?.tools ?? []),
      ...createMcpOperationTools(
        operations,
        executors,
        artifacts.assertAvailable.bind(artifacts),
      ),
    ],
    artifacts,
    ready: () => operations.ready(),
    stop: () => {
      recovery?.stop();
      operations.stop();
      artifacts.stop();
    },
    close: () => closePageSession(operations, artifacts, recovery),
  };
}

function createOcrExecutor(
  app: InpaintingJobContext,
  reader: McpReadingService,
): NonNullable<Parameters<typeof createMcpOperationTools>[1]["ocr"]> {
  return async (target, context) => {
    return runMcpAppJob(
      app,
      context,
      "gemma-analysis",
      (job, emit) =>
        new McpOcrService({
          openChapter,
          recognize: (page, operation) =>
            recognizeMcpPage(app, target.chapterId, page, operation, emit),
          saveReading: (reading, guard) => reader.create(reading, guard),
        }).run({ ...target, revision: target.revision as PageRevision }, job),
      {
        resources: [{ kind: "model-runtime", scope: "*", access: "write" }],
        page: { ...target, readChapter: openChapter },
      },
    );
  };
}

function createErasureExecutor(
  app: InpaintingJobContext,
  editing: Editing,
  recovery: ReturnType<typeof createMcpErasureRecoverySession>,
): NonNullable<Parameters<typeof createMcpOperationTools>[1]["erase"]> {
  return (target, context) =>
    eraseMcpPage(app, editing, target, context, undefined, (reference) =>
      recovery?.remember(context.id, reference.transactionId),
    );
}

async function closePageSession(
  operations: McpOperationService,
  artifacts: McpArtifactStore,
  recovery: ReturnType<typeof createMcpErasureRecoverySession>,
): Promise<void> {
  operations.stop();
  recovery?.stop();
  await recovery?.close();
  await operations.close();
  await artifacts.close();
}

function createExportExecutor(
  app: InpaintingJobContext,
  exporter: McpPageExportService,
): NonNullable<Parameters<typeof createMcpOperationTools>[1]["exportPng"]> {
  return (target, context) =>
    runMcpAppJob(
      app,
      context,
      "page-export",
      (job) => exporter.export(target, job),
      { resources: [], page: { ...target, readChapter: openChapter } },
    );
}
