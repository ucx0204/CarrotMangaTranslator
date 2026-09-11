import type {
  ConfirmImageRedaction,
  ImageRedactionPage,
} from "../shared/imageRedaction";
import type { SaveRedactionWorkspace } from "../shared/imageRedactionWorkspace";
import { RedactionWorkspaceApplicationService } from "./application/redactionWorkspaceService";
import { fingerprintImageFile } from "./imageFingerprint";
import { readImageRedactionState } from "./imageRedactionStore";
import {
  readRedactionWorkspaceStore,
  updateRedactionWorkspaceStore,
} from "./imageRedactionWorkspaceStore";

// Preserve the existing IPC/job facade; it only composes production adapters.
const service = new RedactionWorkspaceApplicationService({
  readDraft: readRedactionWorkspaceStore,
  updateDraft: updateRedactionWorkspaceStore,
  readApproved: readImageRedactionState,
  fingerprint: fingerprintImageFile,
  reportCleanupError: (message, error) => console.error(message, error),
});

export function openRedactionWorkspaceSession(
  pages: ImageRedactionPage[],
  sessionId: string,
  root: string,
) {
  return service.open(pages, sessionId, root);
}
export function getRedactionWorkspacePage(sessionId: string, pageId: string) {
  return service.getPage(sessionId, pageId);
}
export function saveRedactionWorkspace(request: SaveRedactionWorkspace) {
  return service.save(request);
}
export function assertRedactionWorkspaceConfirmation(
  request: ConfirmImageRedaction,
) {
  return service.assertConfirmation(request);
}
export function closeRedactionWorkspace(sessionId: string) {
  return service.close(sessionId);
}
