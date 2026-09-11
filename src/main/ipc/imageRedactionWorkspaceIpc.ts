import { imageRedactionIpcContracts } from "../../shared/ipcImageRedactionContracts";
import { openPendingRedactionWorkspace } from "../jobs/imageRedactionReview";
import { prepareRedactionWorkspace } from "../imageRedactionWorkspacePreparation";
import {
  saveRedactionWorkspace,
  closeRedactionWorkspace,
} from "../imageRedactionWorkspaceSessions";
import { getRedactionWorkspacePreview } from "../imageRedactionWorkspacePreview";
import {
  ownRedactionWorkspace,
  releaseRedactionWorkspaceOwner,
} from "./redactionWorkspaceOwners";
import { trustedHandleContract } from "./trustedIpc";
import type { IpcContext } from "./context";

export function registerImageRedactionWorkspaceIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    imageRedactionIpcContracts.openRedactionWorkspace,
    async (event, request) => {
      const workspace =
        request.kind === "job"
          ? await openPendingRedactionWorkspace(
              request.jobId,
              request.sessionId,
              context.appPaths.dataRoot,
            )
          : await prepareRedactionWorkspace(request, context.appPaths.dataRoot);
      await ownRedactionWorkspace(event.sender, workspace.sessionId);
      return workspace;
    },
  );
  trustedHandleContract(
    context,
    imageRedactionIpcContracts.saveRedactionWorkspace,
    async (_event, request) => saveRedactionWorkspace(request),
  );
  trustedHandleContract(
    context,
    imageRedactionIpcContracts.closeRedactionWorkspace,
    async (_event, sessionId) => {
      const closed = await closeRedactionWorkspace(sessionId);
      releaseRedactionWorkspaceOwner(sessionId);
      return closed;
    },
  );
  trustedHandleContract(
    context,
    imageRedactionIpcContracts.getRedactionWorkspacePreview,
    async (_event, request) =>
      getRedactionWorkspacePreview(request, context.decodeImage),
  );
}
