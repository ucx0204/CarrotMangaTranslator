import React from "react";
import {
  pickPanelFormatPatch,
  type PanelCommand,
  type PanelSyncState,
} from "../../../shared/panelBridgeTypes";
import { panelGateway as mangaGateway } from "../api/panelGateway";
import { appI18n } from "../appI18n";
import { formatErrorMessage } from "../lib/errorPresentation";
import { toast } from "../lib/toastStore";
import type { PanelSessionValue } from "./panelSession";

const noop = (): void => undefined;
const REMOTE_WINDOW_ACTIONS = {
  onBackToPageBlocks: noop,
  onDockEditorWindow: noop,
  onPopOutEditor: noop,
  onToggleEditorFloat: noop,
};

type RemotePresetActions = Pick<
  PanelSessionValue,
  | "onApplyStylePreset"
  | "onCreateStylePreset"
  | "onDeleteStylePreset"
  | "onOpenStylePresetManager"
  | "onOverwriteStylePreset"
>;

type RemoteBlockActions = Pick<
  PanelSessionValue,
  | "onAdjustFontSize"
  | "onDeleteBlock"
  | "onDuplicateBlock"
  | "onEraseBlockOriginal"
  | "onFitBlockBubble"
  | "onInsertBlockLibraryEntry"
  | "onOpenBlockLibrary"
  | "onRemoveBubbleLayout"
  | "onUpdateBlock"
  | "onUpdateFormat"
>;

function dispatchCommand(command: PanelCommand): void {
  void mangaGateway.sendPanelCommand(command).catch((error) => {
    // A dropped command means the panel's control did nothing at all; the user
    // has to know rather than assume the edit landed in the main window.
    toast.error(
      formatErrorMessage(
        error,
        appI18n.t("panels.commandFailed", { ns: "renderer" }),
      ),
    );
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
    canCreateStylePreset: Boolean(syncState.selectedBlock),
    ...REMOTE_WINDOW_ACTIONS,
    onApplyFormat: (scope, groupIds) =>
      dispatchCommand({ type: "applyFormat", scope, groupIds }),
    ...createRemotePresetActions(selectedBlockId, syncState.selectionKey),
    ...createRemoteBlockActions(selectedBlockId, syncState.selectionKey),
    onApplyBlockBackgroundOpacity: (scope) =>
      dispatchCommand({ type: "applyBlockBackgroundOpacity", scope }),
    onSelectTransformMode: (mode) =>
      dispatchCommand({ type: "selectTransformMode", mode }),
    onStartAreaTranslate: () => dispatchCommand({ type: "startAreaTranslate" }),
  };
}

function createRemotePresetActions(
  selectedBlockId: string | undefined,
  selectionKey: string,
): RemotePresetActions {
  return {
    onApplyStylePreset: createRemoteStylePresetApply(
      selectedBlockId,
      selectionKey,
    ),
    onCreateStylePreset: async (input) => {
      if (!selectedBlockId) return false;
      dispatchCommand({
        type: "createStylePreset",
        selectionKey,
        input,
      });
      return true;
    },
    onDeleteStylePreset: async (presetId) => {
      dispatchCommand({ type: "deleteStylePreset", presetId });
      return true;
    },
    onOpenStylePresetManager: () =>
      dispatchCommand({ type: "openStylePresetManager" }),
    onOverwriteStylePreset: async (presetId) => {
      if (!selectedBlockId) return false;
      dispatchCommand({
        type: "overwriteStylePreset",
        selectionKey,
        presetId,
      });
      return true;
    },
  };
}

function createRemoteBlockActions(
  selectedBlockId: string | undefined,
  selectionKey: string,
): RemoteBlockActions {
  return {
    onAdjustFontSize: (adjustment) => {
      if (selectedBlockId) {
        dispatchCommand({
          type: "adjustSelectionFontSize",
          selectionKey,
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
    onInsertBlockLibraryEntry: (entry) =>
      dispatchCommand({ type: "insertBlockLibraryEntry", entry }),
    onOpenBlockLibrary: () => dispatchCommand({ type: "openBlockLibrary" }),
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
    onUpdateBlock: (patch) => {
      if (selectedBlockId) {
        dispatchCommand({
          type: "updateBlock",
          blockId: selectedBlockId,
          patch,
        });
      }
    },
    onUpdateFormat: (patch) => {
      if (selectedBlockId) {
        dispatchCommand({
          type: "updateSelectionFormat",
          selectionKey,
          patch: pickPanelFormatPatch(patch),
        });
      }
    },
  };
}

function createRemoteStylePresetApply(
  selectedBlockId: string | undefined,
  selectionKey: string,
): PanelSessionValue["onApplyStylePreset"] {
  return (presetId) => {
    if (selectedBlockId) {
      dispatchCommand({
        type: "applyStylePreset",
        selectionKey,
        presetId,
      });
    }
  };
}
