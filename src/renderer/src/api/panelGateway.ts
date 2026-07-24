import { createMangaDomainGateway } from "./mangaGateway";

export const panelGateway = createMangaDomainGateway("Panel", [
  "closePanelWindow",
  "getPanelState",
  "onPanelCommand",
  "onPanelState",
  "onPanelWindowsChanged",
  "openPanelWindow",
  "publishPanelState",
  "sendPanelCommand",
] as const);
