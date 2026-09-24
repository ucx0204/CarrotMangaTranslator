import { createMcpAuxiliarySessions } from "./mcpAuxiliarySessions";
import { createMcpPageRetentionSession } from "./mcpPageRetentionSession";
import { createMcpParentSessions } from "./mcpParentSessions";
import { McpParentAdmission } from "./mcpParentAdmission";
import type {
  PageSessionOptions,
  McpPageSessionResources,
  McpPageSessionEditing as Editing,
} from "./mcpPageSessionTypes";
import { McpOutputDeliveryObserver } from "./mcpOutputDeliveryObserver";
import { createMcpOutputDeliveryAdapter } from "./mcpOutputDeliveryAdapter";
import type { createMcpRetentionSession } from "./mcpRetentionSession";
import { bindRetainedOutputSource } from "./mcpRetainedOutputs";
import { createMcpSourceSizeExecutor } from "./mcpSourceSizeAdapter";
import { createMcpTypographyAnalysisSession } from "./mcpTypographyAnalysisSession";
import { createMcpExportBatchAdapter } from "./mcpExportBatchAdapter";
import { createMcpWorkFileExportAdapter } from "./mcpWorkFileExportAdapter";
import { createMcpBlockTranslationExecutor } from "./mcpBlockTranslationSession";
import { createMcpBlockOcrExecutor } from "./mcpBlockOcrSession";
import { createMcpErasureRecoverySession } from "./mcpErasureRecoverySession";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { PageRevision } from "../../shared/pageRevisionTypes";
import { McpOperationService } from "../application/mcpOperationService";
import { McpPageExportService } from "../application/mcpPageExportService";
import { McpOcrService } from "../application/mcpOcrService";
import { McpReadingService } from "../application/mcpReadingService";
import { McpEditError } from "../application/mcpEditPolicy";
import { openChapter, savePageBlocks } from "../library";
import { getAppSettings } from "../settingsStore";
import { readImageRedactionState } from "../imageRedactionStore";
import { renderMcpPagePng, renderMcpPageImage } from "./mcpPageImageAdapter";
import { McpArtifactStore } from "./mcpArtifactStore";
import { createMcpOperationTools } from "./mcpOperationTools";
import { runMcpAppJob } from "./mcpAppJob";
import { eraseMcpPage } from "./mcpErasureAdapter";
import { recognizeMcpPage } from "./mcpOcrAdapter";

/** All heavy work joins the app's existing exclusive job store; only receipts and
 * exported temporary files belong to this MCP connection session. */
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
  const admission = new McpParentAdmission();
  const resources = {
    operations,
    ...createMcpPageRetentionSession(options, admission),
  };
  const { artifacts, retained, observer } = resources;
  const auxiliary = createMcpAuxiliarySessions(options, resources);
  const nativeTools = createPageSessionTools(
    options,
    resources,
    observer,
    auxiliary,
    recovery,
  );
  const parents = createMcpParentSessions(
    options,
    resources,
    nativeTools,
    auxiliary,
    admission,
  );
  return {
    tools: [...(parents?.tools ?? []), ...nativeTools],
    bindNativeTools: parents?.bindNativeTools,
    artifacts,
    wrapTool: retained?.wrap,
    ready: () => readyPageSession(operations, retained),
    stop: () => {
      auxiliary.stop();
      parents?.stop();
      retained?.stop();
      recovery?.stop();
      operations.stop();
      artifacts.stop();
    },
    close: async () => {
      auxiliary.stop();
      parents?.stop();
      await closePageSession(
        operations,
        artifacts,
        recovery,
        auxiliary,
        parents,
        retained,
      );
    },
  };
}
function createPageSessionTools(
  options: PageSessionOptions,
  resources: McpPageSessionResources,
  observer: McpOutputDeliveryObserver,
  auxiliary: ReturnType<typeof createMcpAuxiliarySessions>,
  recovery: ReturnType<typeof createMcpErasureRecoverySession>,
) {
  const { app, editing, preferences } = options;
  const { operations, artifacts, retained } = resources;
  const exporter = createPageExporter(artifacts);
  const exports = createMcpExportBatchAdapter({
    app,
    exporter,
    operations,
    artifacts,
    allowImages: preferences.allowImages,
    reportError: options.reportError,
    borrowOutput: retained
      ? (owner, id, guard, expected) =>
          retained.borrowOutput(owner, id, guard, guard, expected)
      : undefined,
  });
  const reader = createPageReader(app, editing);
  const executors = createPageExecutors(options, reader, recovery, exports);
  return [
    ...createMcpOutputDeliveryAdapter({
      operations,
      artifacts,
      catalog: retained?.catalog,
      observer,
      allowImages: preferences.allowImages,
      sync: auxiliary.diagnoseOutputSync,
    }),
    ...(retained?.tools ?? []),
    ...exports.tools,
    ...createMcpWorkFileExportAdapter({
      app,
      operations,
      artifacts,
      allowImages: preferences.allowImages,
    }).tools,
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
      {
        allowImages: preferences.allowImages,
        disclosed: artifacts.disclosed.bind(artifacts),
      },
    ),
  ];
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
  auxiliary: ReturnType<typeof createMcpAuxiliarySessions>,
  parents: ReturnType<typeof createMcpParentSessions>,
  retained: ReturnType<typeof createMcpRetentionSession> | undefined,
): Promise<void> {
  const errors: unknown[] = [];
  const cleanup = [
    async () => {
      await parents?.close();
    },
    async () => {
      retained?.stop();
      await retained?.close();
    },
    async () => {
      operations.stop();
      await auxiliary.close();
    },
    async () => {
      recovery?.stop();
      await recovery?.close();
    },
    () => operations.close(),
    () => artifacts.close(),
  ];
  for (const close of cleanup) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Page operation session cleanup failed.", {
      cause: errors[0],
    });
}
function createPageExporter(artifacts: McpArtifactStore) {
  return new McpPageExportService({
    openChapter,
    render: renderMcpPagePng,
    bindSource: bindRetainedOutputSource,
    store: artifacts.put.bind(artifacts),
    image: {
      render: renderMcpPageImage,
      store: artifacts.putImage.bind(artifacts),
    },
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
async function readyPageSession(
  operations: McpOperationService,
  retained: ReturnType<typeof createMcpRetentionSession> | undefined,
) {
  await operations.ready();
  await retained?.ready();
}
