import React from "react";
import type {
  PanelCommand,
  PanelSyncState,
} from "../../../shared/panelBridgeTypes";
import { panelGateway as mangaGateway } from "../api/panelGateway";
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
    let active = true;
    void mangaGateway
      .getPanelState()
      .then((state) => {
        if (active && state) {
          setSyncState((current) => current ?? state);
        }
      })
      .catch((error) => {
        if (active) {
          console.error(error);
        }
      });
    return () => {
      active = false;
    };
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
    canCreateStylePreset: false,
    onToggleEditorFloat: noop,
    onBackToPageBlocks: noop,
    onPopOutEditor: noop,
    onDockEditorWindow: noop,
    onApplyFormat: (scope, groupIds) =>
      dispatchCommand({ type: "applyFormat", scope, groupIds }),
    onApplyStylePreset: createRemoteStylePresetApply(selectedBlockId),
    onCreateStylePreset: async () => false,
    onDeleteStylePreset: async (presetId) => {
      dispatchCommand({ type: "deleteStylePreset", presetId });
      return true;
    },
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
    onEraseBlockOriginal: () => {
      if (selectedBlockId) {
        dispatchCommand({
          type: "eraseBlockOriginal",
          blockId: selectedBlockId,
        });
      }
    },
    onFitBlockBubble: () => {
      if (selectedBlockId) {
        dispatchCommand({ type: "fitBlockBubble", blockId: selectedBlockId });
      }
    },
    onRemoveBubbleLayout: () => {
      if (selectedBlockId) {
        dispatchCommand({
          type: "removeBubbleLayout",
          blockId: selectedBlockId,
        });
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

function createRemoteStylePresetApply(
  selectedBlockId: string | undefined,
): PanelSessionValue["onApplyStylePreset"] {
  return (presetId) => {
    if (selectedBlockId) {
      dispatchCommand({
        type: "applyStylePreset",
        blockId: selectedBlockId,
        presetId,
      });
    }
  };
}
