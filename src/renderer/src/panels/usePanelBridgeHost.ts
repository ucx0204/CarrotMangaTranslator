import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type {
  PanelCommand,
  PanelId,
  PanelSyncState,
} from "../../../shared/panelBridgeTypes";
import { panelGateway as mangaGateway } from "../api/panelGateway";

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
  const panelsOpen = openPanelIds.length > 0;

  useEffect(() => {
    syncStateRef.current = syncState;
    onCommandRef.current = onCommand;
  }, [onCommand, syncState]);

  useCoalescedPanelStatePublisher({
    enabled: panelsOpen,
    serialized: panelsOpen ? JSON.stringify(syncState) : "",
    syncStateRef,
  });

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

function useCoalescedPanelStatePublisher({
  enabled,
  serialized,
  syncStateRef,
}: {
  enabled: boolean;
  serialized: string;
  syncStateRef: MutableRefObject<PanelSyncState>;
}): void {
  const enabledRef = useRef(enabled);
  const serializedRef = useRef(serialized);
  const revisionRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const trailingRef = useRef(false);
  const disposedRef = useRef(false);

  const schedulePublish = useCallback(() => {
    if (
      disposedRef.current ||
      !enabledRef.current ||
      frameRef.current !== null
    ) {
      return;
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      if (disposedRef.current || !enabledRef.current) {
        return;
      }
      if (inFlightRef.current) {
        trailingRef.current = true;
        return;
      }

      const publishedRevision = revisionRef.current;
      const state = syncStateRef.current;
      inFlightRef.current = true;
      trailingRef.current = false;
      void Promise.resolve()
        .then(() => mangaGateway.publishPanelState(state))
        .catch((error) => {
          console.error(error);
        })
        .then(() => {
          inFlightRef.current = false;
          const publishAgain =
            trailingRef.current || revisionRef.current !== publishedRevision;
          trailingRef.current = false;
          if (publishAgain) {
            schedulePublish();
          }
        });
    });
  }, [syncStateRef]);

  useEffect(() => {
    const becameEnabled = enabled && !enabledRef.current;
    const stateChanged = serializedRef.current !== serialized;
    enabledRef.current = enabled;
    if (stateChanged) {
      serializedRef.current = serialized;
      revisionRef.current += 1;
    }
    if (!enabled) {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      trailingRef.current = false;
      return;
    }
    if (becameEnabled || stateChanged) {
      schedulePublish();
    }
  }, [enabled, schedulePublish, serialized]);

  usePanelPublisherDisposal(disposedRef, frameRef);
}

function usePanelPublisherDisposal(
  disposedRef: MutableRefObject<boolean>,
  frameRef: MutableRefObject<number | null>,
): void {
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [disposedRef, frameRef]);
}
