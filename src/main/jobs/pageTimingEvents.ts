import { ipcEventContracts } from "../../shared/ipcEventContracts";
import type { PageTimingUpdatedEvent } from "../../shared/pageProcessingTiming";
import type { JobEventWindow } from "./jobEventDispatchQueue";

export function emitPageTimingUpdated(
  mainWindow: JobEventWindow | null,
  event: PageTimingUpdatedEvent,
): void {
  if (
    !mainWindow ||
    mainWindow.isDestroyed?.() ||
    mainWindow.webContents.isDestroyed?.()
  ) {
    return;
  }
  ipcEventContracts.pageTimingUpdated.payload.parse(event);
  mainWindow.webContents.send(
    ipcEventContracts.pageTimingUpdated.channel,
    event,
  );
}
