import { createMcpWorkflowSession } from "./mcpWorkflowSession";
import {
  McpRetentionStorage,
  type McpRetentionCodec,
} from "./mcpRetentionStorage";
import { createMcpRetentionSession } from "./mcpRetentionSession";
import {
  createRetainedOutputPublisher,
  bindRetainedOutputSource,
} from "./mcpRetainedOutputs";
import { createMcpSoundEffectSession } from "./mcpSoundEffectSession";
import { createMcpExternalImageSession } from "./mcpExternalImageSession";
import { createMcpImageEditSession } from "./mcpImageEditSession";
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
type PageSessionOptions = {
  origin: string;
  jobPersistence?: McpJobPersistence;
  retentionCodec?: McpRetentionCodec;
  preferences: McpPreferences;
  app: InpaintingJobContext;
  editing: Editing;
  reportError: (error: unknown) => void;
};
export function createMcpPageOperationSession(options: PageSessionOptions) {
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
  const { artifacts, retained, storage } = createRetainedOutputs(options);
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
  const executors = createPageExecutors(options, reader, recovery, exports);
  const nativeTools = [
    ...(retained?.tools ?? []),
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
  ];
  const workflow = storage
    ? createMcpWorkflowSession({
        app,
        operations,
        storage,
        preferences,
        tools: nativeTools.map((tool) => retained?.wrap(tool) ?? tool),
        waitSelection: auxiliary.waitSelection,
        releaseSelection: auxiliary.releaseSelection,
        reportError: options.reportError,
      })
    : undefined;
  return {
    tools: [...(workflow?.tools ?? []), ...nativeTools],
    artifacts,
    wrapTool: retained?.wrap,
    ready: async () => {
      await operations.ready();
      await retained?.ready();
    },
    stop: () => {
      workflow?.stop();
      retained?.stop();
      auxiliary.stop();
      recovery?.stop();
      operations.stop();
      artifacts.stop();
    },
    close: async () => {
      workflow?.stop();
      await workflow?.close();
      retained?.stop();
      await retained?.close();
      await closePageSession(operations, artifacts, recovery, auxiliary);
    },
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
  const selection = createMcpSelectionAnalysisSession(
    app,
    operations,
    Boolean(preferences.allowProcessing),
    undefined,
    preferences.allowEditing ? editing : undefined,
  );
  const images = createMcpImageEditSession(
    app,
    editing,
    Boolean(preferences.allowEditing && preferences.allowProcessing),
    Boolean(preferences.allowImages),
  );
  const externalImages = createMcpExternalImageSession(
    app,
    editing,
    Boolean(preferences.allowEditing && preferences.allowProcessing),
    Boolean(preferences.allowImages),
  );
  const soundEffects = createMcpSoundEffectSession(
    app,
    operations,
    editing,
    Boolean(preferences.allowEditing && preferences.allowProcessing),
    Boolean(preferences.allowImages),
  );
  const stop = () => {
    soundEffects.stop();
    externalImages.stop();
    images.stop();
    context.stop();
    typography.stop();
    lettering.stop();
    selection.stop();
  };
  return {
    waitSelection: selection.waitForEdit,
    releaseSelection: selection.releaseEdit,
    tools: [
      ...soundEffects.tools,
      ...context.tools,
      ...typography.tools,
      ...lettering.tools,
      ...selection.tools,
      ...images.tools,
      ...externalImages.tools,
    ],
    stop,
    close: async () => {
      stop();
      await soundEffects.close();
      await externalImages.close();
      await images.close();
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
    bindSource: bindRetainedOutputSource,
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

function createRetainedOutputs(options: PageSessionOptions) {
  const { app, editing, preferences } = options;
  const storage = options.retentionCodec
    ? new McpRetentionStorage(options.retentionCodec)
    : undefined;
  const artifacts = new McpArtifactStore(
    options.origin,
    Date.now,
    storage ? createRetainedOutputPublisher(storage) : undefined,
  );
  const retained = storage
    ? createMcpRetentionSession(
        storage,
        artifacts,
        app,
        editing,
        Boolean(preferences.allowEditing && preferences.allowProcessing),
        preferences.allowImages,
      )
    : undefined;
  return { artifacts, retained, storage };
}
function createPageExecutors(
  options: PageSessionOptions,
  reader: McpReadingService,
  recovery: ReturnType<typeof createMcpErasureRecoverySession>,
  exports: ReturnType<typeof createMcpExportBatchAdapter>,
): Parameters<typeof createMcpOperationTools>[1] {
  const { app, editing, preferences } = options;
  return {
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
}
