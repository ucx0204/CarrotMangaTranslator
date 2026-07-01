import React from "react";
import type {
  PanelCommand,
  PanelSyncState,
} from "../../../shared/panelBridgeTypes";
import { mangaGateway } from "../api/mangaGateway";
import type { PanelSessionValue } from "./panelSession";

const noop = (): void => undefined;

function dispatchCommand(command: PanelCommand): void {
  void mangaGateway.sendPanelCommand(command).catch((error) => {
    console.error(error);
  });
}

/**
 * Pop-out window side of the panel bridge. Subscribes to state snapshots from
 * the main window and turns panel actions into commands relayed back to it.
 * Returns null until the first snapshot arrives.
 */
export function useRemotePanelSession(): PanelSessionValue | null {
  const [syncState, setSyncState] = React.useState<PanelSyncState | null>(null);
  React.useEffect(() => {
    return mangaGateway.onPanelState((state) => {
      setSyncState(state);
    });
  }, []);
  React.useEffect(() => {
    void mangaGateway
      .getPanelState()
      .then((state) => {
        if (state) {
          setSyncState((current) => current ?? state);
        }
      })
      .catch((error) => {
        console.error(error);
      });
  }, []);
  return React.useMemo(
    () => (syncState ? buildRemotePanelSessionValue(syncState) : null),
    [syncState],
  );
}

function buildRemotePanelSessionValue(
  syncState: PanelSyncState,
): PanelSessionValue {
  return {
    ...syncState,
    editorFloating: false,
    editorPoppedOut: false,
    showDetachControls: false,
    onToggleEditorFloat: noop,
    onPopOutEditor: noop,
    onDockEditorWindow: noop,
    onApplyFormat: (scope, groupIds) =>
      dispatchCommand({ type: "applyFormat", scope, groupIds }),
    onDeleteBlock: () => dispatchCommand({ type: "deleteBlock" }),
    onDuplicateBlock: () => dispatchCommand({ type: "duplicateBlock" }),
    onStartAreaTranslate: () => dispatchCommand({ type: "startAreaTranslate" }),
    onUpdateBlock: (patch) => dispatchCommand({ type: "updateBlock", patch }),
  };
}
