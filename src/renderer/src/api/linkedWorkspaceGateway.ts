import { createMangaDomainGateway } from "./mangaGateway";

export const linkedWorkspaceGateway = createMangaDomainGateway(
  "Linked workspace",
  [
    "getLinkedWorkspaceStatus",
    "listLinkedWorkspaceStatuses",
    "connectLinkedWorkspace",
    "updateLinkedWorkspace",
    "reconnectLinkedWorkspace",
    "resetLinkedWorkspaceLocation",
    "disconnectLinkedWorkspace",
    "viewLinkedResults",
    "reportLinkedWorkspaceActivity",
    "onLinkedWorkspaceStatusChanged",
  ] as const,
);
