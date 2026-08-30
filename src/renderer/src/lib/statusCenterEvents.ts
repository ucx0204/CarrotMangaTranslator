export const OPEN_STATUS_CENTER_EVENT = "manga-translator:open-status-center";

export function requestStatusCenterOpen(): void {
  window.dispatchEvent(new Event(OPEN_STATUS_CENTER_EVENT));
}
