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
  const selectedBlockId = syncState.selectedBlock?.id;
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
    onApplyBlockBackgroundOpacity: (scope) =>
      dispatchCommand({ type: "applyBlockBackgroundOpacity", scope }),
    onAdjustFontSize: (adjustment) => {
      if (selectedBlockId) {
        dispatchCommand({
          type: "adjustFontSize",
          blockId: selectedBlockId,
          adjustment,
        });
      }
    },
    onDeleteBlock: () => {
      if (selectedBlockId) {
        dispatchCommand({ type: "deleteBlock", blockId: selectedBlockId });
      }
    },
    onDuplicateBlock: () => {
      if (selectedBlockId) {
        dispatchCommand({ type: "duplicateBlock", blockId: selectedBlockId });
      }
    },
    onOcrBlock: () => {
      if (selectedBlockId) {
        dispatchCommand({ type: "ocrBlock", blockId: selectedBlockId });
      }
    },
    onTranslateBlock: () => {
      if (selectedBlockId) {
        dispatchCommand({ type: "translateBlock", blockId: selectedBlockId });
      }
    },
    onSelectTransformMode: (mode) =>
      dispatchCommand({ type: "selectTransformMode", mode }),
    onStartAreaTranslate: () => dispatchCommand({ type: "startAreaTranslate" }),
    onUpdateBlock: (patch) => {
      if (selectedBlockId) {
        dispatchCommand({
          type: "updateBlock",
          blockId: selectedBlockId,
          patch,
        });
      }
    },
  };
}
