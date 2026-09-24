import { createMcpLibraryOrganizationSession } from "./mcpLibraryOrganizationSession";
import { createMcpLibraryImportSession } from "./mcpLibraryImportSession";
import { createMcpSoundEffectSession } from "./mcpSoundEffectSession";
import { createMcpExternalImageSession } from "./mcpExternalImageSession";
import { createMcpImageEditSession } from "./mcpImageEditSession";
import { createMcpSelectionAnalysisSession } from "./mcpSelectionAnalysisSession";
import { createMcpLetteringSession } from "./mcpLetteringSession";
import { createMcpContextSession } from "./mcpContextSession";
import { createMcpTypographyBatchSession } from "./mcpTypographyBatchSession";
import { createMcpExchangeSession } from "./mcpExchangeSession";
import { createMcpOutputSyncSession } from "./mcpOutputSyncSession";
import type {
  PageSessionOptions,
  McpPageSessionResources,
} from "./mcpPageSessionTypes";

export function createMcpAuxiliarySessions(
  options: PageSessionOptions,
  resources: McpPageSessionResources,
) {
  const { app, editing, preferences } = options;
  const { operations, storage } = resources;
  const outputSync = resources.outputSyncReceipts
    ? createMcpOutputSyncSession({
        app,
        editing,
        preferences,
        operations,
        repository: resources.outputSyncReceipts,
        port: options.outputSync,
        reportError: options.reportError,
      })
    : undefined;
  const context = createMcpContextSession(
    app,
    operations,
    preferences,
    storage ? { storage, editing } : undefined,
  );
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
  const incoming = createIncomingFileSessions(options, resources);
  const images = createImageSessions(options, operations);
  const sessions = [
    ...(outputSync ? [outputSync] : []),
    ...incoming.sessions,
    ...images.sessions,
    selection,
    lettering,
    typography,
    context,
  ];
  return {
    ...auxiliaryLifecycle(sessions),
    waitSelection: selection.waitForEdit,
    releaseSelection: selection.releaseEdit,
    diagnoseOutputSync: outputSync?.diagnose,
    composite: {
      imageReviewMapping: incoming.imports?.reviewMapping,
      workFileReviewMapping: incoming.imports?.workFileReviewMapping,
      research: context.researchCompletion,
      readSoundEffectPlan: images.soundEffects.readOwnedPlan,
      batches: {
        "selection-apply": selection.waitForEdit,
        "typography-apply": typography.waitForAction,
        "lettering-apply": lettering.waitForAction,
        "sfx-apply": images.soundEffects.waitForAction,
      },
    },
    tools: sessions.flatMap((session) => session.tools),
  };
}
/** Shared upload and retained migration authorities are composed once for incoming files. */
function createIncomingFileSessions(
  options: PageSessionOptions,
  resources: McpPageSessionResources,
) {
  const { app, editing, preferences } = options;
  const { operations, storage, retained, artifacts } = resources;
  const imports = storage
    ? createMcpLibraryImportSession({
        app,
        operations,
        storage,
        preferences,
        reportError: options.reportError,
      })
    : undefined;
  const exchange =
    imports && retained
      ? createMcpExchangeSession({
          app,
          operations,
          artifacts,
          uploads: imports.uploads,
          migration: retained.migration,
          editing,
          allowEditing: Boolean(
            preferences.allowEditing && preferences.allowProcessing,
          ),
        })
      : undefined;
  return {
    imports,
    sessions: [
      ...(storage
        ? [
            createMcpLibraryOrganizationSession(
              storage,
              preferences,
              editing.notifyLibraryChanged,
              editing.assertChapterClosed,
            ),
          ]
        : []),
      ...(exchange ? [exchange] : []),
      ...(imports ? [imports] : []),
    ],
  };
}
/** Image editing remains independently permissioned from incoming library files. */
function createImageSessions(
  options: PageSessionOptions,
  operations: McpPageSessionResources["operations"],
) {
  const { app, editing, preferences } = options;
  const enabled = Boolean(
    preferences.allowEditing && preferences.allowProcessing,
  );
  const images = Boolean(preferences.allowImages);
  const soundEffects = createMcpSoundEffectSession(
    app,
    operations,
    editing,
    enabled,
    images,
  );
  return {
    soundEffects,
    sessions: [
      soundEffects,
      createMcpExternalImageSession(app, editing, enabled, images),
      createMcpImageEditSession(app, editing, enabled, images),
    ],
  };
}
/** Stop every auxiliary admission before awaiting its ordered cleanup. */
function auxiliaryLifecycle(
  sessions: readonly { stop: () => void; close: () => Promise<void> }[],
) {
  const stop = () => {
    for (const session of sessions) session.stop();
  };
  return {
    stop,
    close: async () => {
      stop();
      for (const session of sessions) await session.close();
    },
  };
}
