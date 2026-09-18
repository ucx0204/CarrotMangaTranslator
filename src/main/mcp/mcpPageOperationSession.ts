import { createMcpSelectionAnalysisSession } from "./mcpSelectionAnalysisSession";
import { createMcpLetteringSession } from "./mcpLetteringSession";
import { createMcpSourceSizeExecutor } from "./mcpSourceSizeAdapter";
import { createMcpTypographyAnalysisSession } from "./mcpTypographyAnalysisSession";
import { createMcpTypographyBatchSession } from "./mcpTypographyBatchSession";
import { createMcpExportBatchAdapter } from "./mcpExportBatchAdapter";
import { createMcpContextSession } from "./mcpContextSession";
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
  const auxiliary = createAuxiliarySessions(
    app,
    operations,
    editing,
    preferences,
  );
  const artifacts = new McpArtifactStore(options.origin);
  const exporter = createPageExporter(artifacts);
  const exports = createMcpExportBatchAdapter({
    app,
    exporter,
    operations,
    artifacts,
    allowImages: preferences.allowImages,
    reportError: options.reportError,
  });
  const reader = createPageReader(app, editing);
  const executors: Parameters<typeof createMcpOperationTools>[1] = {
    exportPng: preferences.allowImages ? exports.exportPage : undefined,
    ocr: preferences.allowProcessing
      ? createOcrExecutor(app, reader)
      : undefined,
    sourceSize: preferences.allowProcessing
      ? createMcpSourceSizeExecutor(app)
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
      ...exports.tools,
      ...createMcpTypographyAnalysisSession(
        app,
        operations,
        Boolean(preferences.allowProcessing),
      ),
      ...auxiliary.tools,
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
      auxiliary.stop();
      recovery?.stop();
      operations.stop();
      artifacts.stop();
    },
    close: () => closePageSession(operations, artifacts, recovery, auxiliary),
  };
}

function createAuxiliarySessions(
  app: InpaintingJobContext,
  operations: McpOperationService,
  editing: Editing,
  preferences: McpPreferences,
) {
  const context = createMcpContextSession(app, operations, preferences);
  const typography = createMcpTypographyBatchSession(
    app,
    operations,
    editing,
    Boolean(preferences.allowEditing && preferences.allowProcessing),
  );
  const lettering = createMcpLetteringSession(
    app,
    operations,
    editing,
    Boolean(preferences.allowEditing && preferences.allowProcessing),
  );
  const selection = createMcpSelectionAnalysisSession(app, operations, Boolean(preferences.allowProcessing));
  const stop = () => {
    context.stop();
    typography.stop();
    lettering.stop();
    selection.stop();
  };
  return {
    tools: [...context.tools, ...typography.tools, ...lettering.tools, ...selection.tools],
    stop,
    close: async () => {
      stop();
      await selection.close();
      await lettering.close();
      await typography.close();
      await context.close();
    },
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
  auxiliary: ReturnType<typeof createAuxiliarySessions>,
): Promise<void> {
  operations.stop();
  await auxiliary.close();
  recovery?.stop();
  await recovery?.close();
  await operations.close();
  await artifacts.close();
}

function createPageExporter(artifacts: McpArtifactStore) {
  return new McpPageExportService({
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
}

function createPageReader(app: InpaintingJobContext, editing: Editing) {
  return new McpReadingService({
    openChapter,
    savePageBlocks,
    assertWritable: editing.assertClean,
    notifySaved: editing.notifySaved,
    defaults: async () =>
      (await getAppSettings(app.appPaths)).blockFormatDefaults,
  });
}
