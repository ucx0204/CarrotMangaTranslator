import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PanelCommand,
  PanelId,
  PanelSyncState,
} from "../../../shared/panelBridgeTypes";
import { mangaGateway } from "../api/mangaGateway";

/**
 * Main-window side of the panel bridge. Publishes the serializable session slice
 * to popped-out panel windows, relays their commands back into the session
 * action handlers, and tracks which panels are currently open in their own OS
 * window. The main window stays the single source of truth.
 */
export function usePanelBridgeHost({
  syncState,
  onCommand,
}: {
  syncState: PanelSyncState;
  onCommand: (command: PanelCommand) => void;
}): {
  openPanelIds: PanelId[];
  openEditorWindow: () => void;
  closeEditorWindow: () => void;
} {
  const [openPanelIds, setOpenPanelIds] = useState<PanelId[]>([]);
  const syncStateRef = useRef(syncState);
  const onCommandRef = useRef(onCommand);

  useEffect(() => {
    syncStateRef.current = syncState;
    onCommandRef.current = onCommand;
  });

  const serialized = JSON.stringify(syncState);
  useEffect(() => {
    void mangaGateway.publishPanelState(syncStateRef.current).catch((error) => {
      console.error(error);
    });
  }, [serialized]);

  useEffect(() => {
    return mangaGateway.onPanelCommand((command) => {
      onCommandRef.current(command);
    });
  }, []);

  useEffect(() => {
    return mangaGateway.onPanelWindowsChanged((ids) => {
      setOpenPanelIds(ids);
    });
  }, []);

  const openEditorWindow = useCallback(() => {
    void mangaGateway.openPanelWindow("editor").catch((error) => {
      console.error(error);
    });
  }, []);
  const closeEditorWindow = useCallback(() => {
    void mangaGateway.closePanelWindow("editor").catch((error) => {
      console.error(error);
    });
  }, []);

  return { openPanelIds, openEditorWindow, closeEditorWindow };
}
