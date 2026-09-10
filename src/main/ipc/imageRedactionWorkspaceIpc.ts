import { imageRedactionIpcContracts } from "../../shared/ipcImageRedactionContracts";
import { openPendingRedactionWorkspace } from "../jobs/imageRedactionReview";
import { prepareRedactionWorkspace } from "../imageRedactionWorkspacePreparation";
import { saveRedactionWorkspace, closeRedactionWorkspace } from "../imageRedactionWorkspaceSessions";
import { getRedactionWorkspacePreview } from "../imageRedactionWorkspacePreview";
import { trustedHandleContract } from "./trustedIpc";
import type { IpcContext } from "./context";

export function registerImageRedactionWorkspaceIpc(context: IpcContext): void {
  trustedHandleContract(context, imageRedactionIpcContracts.openRedactionWorkspace,
    async (_event, request) => request.kind === "job"
      ? openPendingRedactionWorkspace(request.jobId, request.sessionId)
      : prepareRedactionWorkspace(request));
  trustedHandleContract(context, imageRedactionIpcContracts.saveRedactionWorkspace,
    async (_event, request) => saveRedactionWorkspace(request));
  trustedHandleContract(context, imageRedactionIpcContracts.closeRedactionWorkspace,
    async (_event, sessionId) => closeRedactionWorkspace(sessionId));
  trustedHandleContract(context, imageRedactionIpcContracts.getRedactionWorkspacePreview,
    async (_event, request) => getRedactionWorkspacePreview(request));
}
