import { dialog } from "electron";
import { linkedWorkspaceIpcContracts } from "../../shared/ipcContracts";
import type { IpcContext } from "./context";
import {
  registeredRendererHandleContract,
  trustedHandleContract,
} from "./trustedIpc";

export function registerLinkedWorkspaceIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    linkedWorkspaceIpcContracts.getLinkedWorkspaceStatus,
    async (_event, chapterId) => requireService(context).getStatus(chapterId),
  );
  trustedHandleContract(
    context,
    linkedWorkspaceIpcContracts.listLinkedWorkspaceStatuses,
    async (_event, chapterIds) =>
      chapterIds.map((chapterId) =>
        requireService(context).getStatus(chapterId),
      ),
  );
  trustedHandleContract(
    context,
    linkedWorkspaceIpcContracts.connectLinkedWorkspace,
    async (_event, request) =>
      requireService(context).connect({
        ...request,
        rootPath: undefined,
        destinationKind: "managed",
        enqueueExistingPages: true,
      }),
  );
  trustedHandleContract(
    context,
    linkedWorkspaceIpcContracts.updateLinkedWorkspace,
    async (_event, request) => requireService(context).update(request),
  );
  trustedHandleContract(
    context,
    linkedWorkspaceIpcContracts.reconnectLinkedWorkspace,
    async (_event, connectionId) => {
      const rootPath = await pickAcceptedConnectionFolder(context);
      if (!rootPath) return null;
      return requireService(context).reconnect(connectionId, rootPath);
    },
  );
  trustedHandleContract(
    context,
    linkedWorkspaceIpcContracts.resetLinkedWorkspaceLocation,
    async (_event, connectionId) =>
      requireService(context).resetToManaged(connectionId),
  );
  trustedHandleContract(
    context,
    linkedWorkspaceIpcContracts.disconnectLinkedWorkspace,
    async (_event, connectionId) => ({
      completed: await requireService(context).disconnect(connectionId),
    }),
  );
  trustedHandleContract(
    context,
    linkedWorkspaceIpcContracts.viewLinkedResults,
    async (_event, request) => requireService(context).viewResults(request),
  );
  registeredRendererHandleContract(
    context,
    linkedWorkspaceIpcContracts.reportLinkedWorkspaceActivity,
    async (_event, request) => {
      requireService(context).reportActivity(request);
      return { completed: true };
    },
  );
}

async function pickConnectionFolder(
  context: IpcContext,
): Promise<string | null> {
  const options = {
    title: "결과물을 자동 저장할 폴더 선택",
    properties: ["openDirectory"] as Electron.OpenDialogOptions["properties"],
  } satisfies Electron.OpenDialogOptions;
  const window = context.getMainWindow();
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

async function pickAcceptedConnectionFolder(
  context: IpcContext,
): Promise<string | null> {
  while (true) {
    const rootPath = await pickConnectionFolder(context);
    if (!rootPath) return null;
    const accepted = await confirmConnectionConflicts(context, rootPath);
    if (accepted === "replace") return rootPath;
    if (accepted === "cancel") return null;
  }
}

async function confirmConnectionConflicts(
  context: IpcContext,
  rootPath: string,
): Promise<"replace" | "pick-again" | "cancel"> {
  const count = await requireService(context).countConflicts(rootPath);
  if (count === 0) return "replace";
  const options = {
    type: "warning",
    title: "기존 결과 파일 확인",
    message: `선택한 폴더에 기존 결과 파일 ${count}개가 있습니다.`,
    detail: "교체를 선택하면 앱이 관리하는 결과 파일만 원자적으로 갱신합니다.",
    buttons: ["교체", "다른 폴더 선택", "취소"],
    defaultId: 1,
    cancelId: 2,
    noLink: true,
  } satisfies Electron.MessageBoxOptions;
  const window = context.getMainWindow();
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  return result.response === 0
    ? "replace"
    : result.response === 1
      ? "pick-again"
      : "cancel";
}

function requireService(context: IpcContext) {
  if (!context.linkedWorkspaceSync) {
    throw new Error("Linked workspace synchronization is unavailable.");
  }
  return context.linkedWorkspaceSync;
}
