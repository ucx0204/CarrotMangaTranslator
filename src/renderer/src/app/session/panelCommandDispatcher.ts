import type { PanelCommand } from "../../../../shared/panelBridgeTypes";

type UpdateBlockCommand = Extract<PanelCommand, { type: "updateBlock" }>;
type AdjustFontSizeCommand = Extract<PanelCommand, { type: "adjustFontSize" }>;
type ApplyFormatCommand = Extract<PanelCommand, { type: "applyFormat" }>;
type ApplyBackgroundCommand = Extract<
  PanelCommand,
  { type: "applyBlockBackgroundOpacity" }
>;
type SelectTransformCommand = Extract<
  PanelCommand,
  { type: "selectTransformMode" }
>;
type ApplyStylePresetCommand = Extract<
  PanelCommand,
  { type: "applyStylePreset" }
>;

export type PanelCommandTarget = {
  updateBlock: (blockId: string, patch: UpdateBlockCommand["patch"]) => void;
  adjustSelectedBlockFontSize: (
    adjustment: AdjustFontSizeCommand["adjustment"],
  ) => void;
  deleteSelectedBlock: () => void;
  duplicateSelectedBlock: () => void;
  eraseBlockOriginal: (blockId: string) => void;
  fitBlockBubble: (blockId: string) => void;
  removeSelectedBlockBubbleLayout: () => void;
  applyFormatToScope: (
    scope: ApplyFormatCommand["scope"],
    groupIds: ApplyFormatCommand["groupIds"],
  ) => void;
  applyStylePreset: (presetId: ApplyStylePresetCommand["presetId"]) => void;
  applyBlockBackgroundOpacityToScope: (
    scope: ApplyBackgroundCommand["scope"],
  ) => void;
  selectWorkspaceTool: (mode: SelectTransformCommand["mode"]) => void;
  startAreaTranslate: () => void;
};

export function dispatchPanelCommand({
  actions,
  busy,
  command,
  selectedBlockId,
}: {
  actions: PanelCommandTarget;
  busy: boolean;
  command: PanelCommand;
  selectedBlockId: string | null;
}): boolean {
  if (busy || isStaleBlockCommand(command, selectedBlockId)) {
    return false;
  }
  if (command.type === "applyStylePreset") {
    actions.applyStylePreset(command.presetId);
  } else {
    applyPanelCommand(actions, command);
  }
  return true;
}

function applyPanelCommand(
  actions: PanelCommandTarget,
  command: Exclude<PanelCommand, ApplyStylePresetCommand>,
): void {
  switch (command.type) {
    case "updateBlock":
      actions.updateBlock(command.blockId, command.patch);
      return;
    case "adjustFontSize":
      actions.adjustSelectedBlockFontSize(command.adjustment);
      return;
    case "deleteBlock":
      actions.deleteSelectedBlock();
      return;
    case "duplicateBlock":
      actions.duplicateSelectedBlock();
      return;
    case "eraseBlockOriginal":
      actions.eraseBlockOriginal(command.blockId);
      return;
    case "fitBlockBubble":
      actions.fitBlockBubble(command.blockId);
      return;
    case "removeBubbleLayout":
      actions.removeSelectedBlockBubbleLayout();
      return;
    case "selectTransformMode":
      actions.selectWorkspaceTool(command.mode);
      return;
    case "applyFormat":
      actions.applyFormatToScope(command.scope, command.groupIds);
      return;
    case "applyBlockBackgroundOpacity":
      actions.applyBlockBackgroundOpacityToScope(command.scope);
      return;
    case "startAreaTranslate":
      actions.startAreaTranslate();
  }
}

function isStaleBlockCommand(
  command: PanelCommand,
  selectedBlockId: string | null,
): boolean {
  return command.type === "updateBlock" ||
    command.type === "adjustFontSize" ||
    command.type === "deleteBlock" ||
    command.type === "duplicateBlock" ||
    command.type === "eraseBlockOriginal" ||
    command.type === "fitBlockBubble" ||
    command.type === "removeBubbleLayout" ||
    command.type === "applyStylePreset"
    ? command.blockId !== selectedBlockId
    : false;
}
