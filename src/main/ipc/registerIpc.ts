import type { IpcContext } from "./context";
import { disposeImportPreviewSessions } from "./importPreviewSessionStore";
import { registerErrorReportIpc } from "./errorReportIpc";
import { registerExternalLinksIpc } from "./externalLinksIpc";
import { registerFontsIpc } from "./fontsIpc";
import { registerImportShareIpc } from "./importShareIpc";
import { registerInpaintingIpc } from "./inpaintingIpc";
import { registerJobControlIpc } from "./jobControlIpc";
import { registerLibraryIpc } from "./libraryIpc";
import { registerLogsIpc } from "./logsIpc";
import { registerPanelWindowsIpc } from "./panelWindowsIpc";
import { registerAppOperationIpc } from "./appOperationIpc";
import { registerPageImageExportIpc } from "./pageImageExportIpc";
import { registerSettingsIpc } from "./settingsIpc";
import { registerTextExportIpc } from "./textExportIpc";
import { registerTranslationJobIpc } from "./translationJobIpc";
import { registerReviewTextIpc } from "./reviewTextIpc";
import { registerWorkContextIpc } from "./workContextIpc";
import { registerWebImportIpc } from "./webImportIpc";
import { registerBlockLibraryIpc } from "./blockLibraryIpc";
import { registerConditionalBatchIpc } from "./conditionalBatchIpc";
import { registerLinkedWorkspaceIpc } from "./linkedWorkspaceIpc";
import { WebImportSessionManager } from "../webImportSessionManager";
import {
  registerWebImportPreviewProtocolHandler,
  registerWebImportPreviewProtocolScheme,
} from "../webImportProtocol";

export type ImportRuntimeResources = {
  webImportManager: WebImportSessionManager;
  initialize: () => Promise<void>;
  dispose: () => Promise<void>;
};

export function registerImportProtocolSchemes(): void {
  registerWebImportPreviewProtocolScheme();
}

export function createImportRuntimeResources({
  dataRoot,
  reportError,
}: {
  dataRoot: string;
  reportError: (message: string, detail?: unknown) => void;
}): ImportRuntimeResources {
  const webImportManager = new WebImportSessionManager({
    dataRoot,
    reportError,
  });
  return {
    webImportManager,
    initialize: async () => {
      await webImportManager.initialize();
      registerWebImportPreviewProtocolHandler(webImportManager);
    },
    dispose: async () => {
      const results = await Promise.allSettled([
        disposeImportPreviewSessions(),
        webImportManager.dispose(),
      ]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "Transient import cleanup failed.");
      }
    },
  };
}

export function registerIpc(context: IpcContext): void {
  registerAppOperationIpc(context);
  registerBlockLibraryIpc(context);
  registerConditionalBatchIpc(context);
  registerExternalLinksIpc(context);
  registerErrorReportIpc(context);
  registerLogsIpc(context);
  registerSettingsIpc(context);
  registerLibraryIpc(context);
  registerFontsIpc(context);
  registerImportShareIpc(context);
  registerWebImportIpc(context);
  registerTextExportIpc(context);
  registerReviewTextIpc(context);
  registerWorkContextIpc(context);
  registerTranslationJobIpc(context);
  registerInpaintingIpc(context);
  registerPageImageExportIpc(context);
  registerLinkedWorkspaceIpc(context);
  registerJobControlIpc(context);
  registerPanelWindowsIpc(context);
}
