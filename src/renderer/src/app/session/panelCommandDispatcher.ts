import type { PanelCommand } from "../../../../shared/panelBridgeTypes";

type UpdateBlockCommand = Extract<PanelCommand, { type: "updateBlock" }>;
type AdjustFontSizeCommand = Extract<PanelCommand, { type: "adjustFontSize" }>;
type AdjustSelectionFontSizeCommand = Extract<
  PanelCommand,
  { type: "adjustSelectionFontSize" }
>;
type UpdateSelectionFormatCommand = Extract<
  PanelCommand,
  { type: "updateSelectionFormat" }
>;
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
type DeleteStylePresetCommand = Extract<
  PanelCommand,
  { type: "deleteStylePreset" }
>;
type CreateStylePresetCommand = Extract<
  PanelCommand,
  { type: "createStylePreset" }
>;
type OverwriteStylePresetCommand = Extract<
  PanelCommand,
  { type: "overwriteStylePreset" }
>;
type RenameStylePresetCommand = Extract<
  PanelCommand,
  { type: "renameStylePreset" }
>;
type AlwaysAvailablePanelCommand = Extract<
  PanelCommand,
  | { type: "openBlockLibrary" }
  | { type: "openStylePresetManager" }
  | { type: "openFontManager" }
  | { type: "suggestConsistentEdit" }
>;
type SelectionEditCommand =
  | AdjustSelectionFontSizeCommand
  | UpdateSelectionFormatCommand;

export type PanelCommandTarget = {
  updateBlock: (blockId: string, patch: UpdateBlockCommand["patch"]) => void;
  adjustSelectedBlockFontSize: (
    adjustment: AdjustFontSizeCommand["adjustment"],
  ) => void;
  adjustSelectedBlocksFontSize: (
    adjustment: AdjustSelectionFontSizeCommand["adjustment"],
  ) => void;
  updateSelectedBlocks: (patch: UpdateSelectionFormatCommand["patch"]) => void;
  deleteSelectedBlock: () => void;
  duplicateSelectedBlock: () => void;
  openBlockLibrary: () => void;
  suggestConsistentEdit?: (find: string, replace: string) => void;
  insertBlockLibraryEntry: (
    entry: Extract<PanelCommand, { type: "insertBlockLibraryEntry" }>["entry"],
  ) => void;
  eraseBlockOriginal: (blockId: string) => void;
  fitBlockBubble: (blockId: string) => void;
  removeSelectedBlockBubbleLayout: () => void;
  applyFormatToScope: (
    scope: ApplyFormatCommand["scope"],
    groupIds: ApplyFormatCommand["groupIds"],
  ) => void;
  applyStylePreset: (presetId: ApplyStylePresetCommand["presetId"]) => void;
  deleteStylePreset: (presetId: ApplyStylePresetCommand["presetId"]) => void;
  openStylePresetManager: () => void;
  openFontManager: () => void;
  createStylePreset: (input: CreateStylePresetCommand["input"]) => void;
  overwriteStylePreset: (
    presetId: OverwriteStylePresetCommand["presetId"],
  ) => void;
  renameStylePreset: (
    presetId: RenameStylePresetCommand["presetId"],
    name: RenameStylePresetCommand["name"],
  ) => void;
  applyBlockBackgroundOpacityToScope: (
    scope: ApplyBackgroundCommand["scope"],
  ) => void;
  selectWorkspaceTool: (mode: SelectTransformCommand["mode"]) => void;
  startAreaTranslate: () => void;
};

function dispatchAlwaysAvailablePanelCommand(
  actions: PanelCommandTarget,
  command: AlwaysAvailablePanelCommand,
): void {
  if (command.type === "openBlockLibrary") {
    actions.openBlockLibrary();
    return;
  }
  if (command.type === "openStylePresetManager") {
    actions.openStylePresetManager();
    return;
  }
  if (command.type === "openFontManager") {
    actions.openFontManager();
    return;
  }
  actions.suggestConsistentEdit?.(command.find, command.replace);
}

function isAlwaysAvailablePanelCommand(
  command: PanelCommand,
): command is AlwaysAvailablePanelCommand {
  return (
    command.type === "openBlockLibrary" ||
    command.type === "openStylePresetManager" ||
    command.type === "openFontManager" ||
    command.type === "suggestConsistentEdit"
  );
}

export function dispatchPanelCommand({
  actions,
  busy,
  command,
  selectedBlockId,
  selectionKey,
}: {
  actions: PanelCommandTarget;
  busy: boolean;
  command: PanelCommand;
  selectedBlockId: string | null;
  selectionKey: string;
}): boolean {
  if (isAlwaysAvailablePanelCommand(command)) {
    dispatchAlwaysAvailablePanelCommand(actions, command);
    return true;
  }
  if (
    busy ||
    isStaleBlockCommand(command, selectedBlockId) ||
    isStaleSelectionCommand(command, selectionKey)
  ) {
    return false;
  }
  if (command.type === "applyStylePreset") {
    actions.applyStylePreset(command.presetId);
  } else if (command.type === "deleteStylePreset") {
    actions.deleteStylePreset(command.presetId);
  } else if (command.type === "insertBlockLibraryEntry") {
    actions.insertBlockLibraryEntry(command.entry);
  } else if (command.type === "createStylePreset") {
    actions.createStylePreset(command.input);
  } else if (command.type === "overwriteStylePreset") {
    actions.overwriteStylePreset(command.presetId);
  } else if (command.type === "renameStylePreset") {
    actions.renameStylePreset(command.presetId, command.name);
  } else {
    applyPanelCommand(actions, command);
  }
  return true;
}

function applyPanelCommand(
  actions: PanelCommandTarget,
  command: Exclude<
    PanelCommand,
    | Extract<PanelCommand, { type: "openBlockLibrary" }>
    | Extract<PanelCommand, { type: "openStylePresetManager" }>
    | Extract<PanelCommand, { type: "suggestConsistentEdit" }>
    | ApplyStylePresetCommand
    | DeleteStylePresetCommand
    | CreateStylePresetCommand
    | OverwriteStylePresetCommand
    | RenameStylePresetCommand
    | Extract<PanelCommand, { type: "openFontManager" }>
    | Extract<PanelCommand, { type: "insertBlockLibraryEntry" }>
  >,
): void {
  if (isSelectionEditCommand(command)) {
    applySelectionEditCommand(actions, command);
    return;
  }
  applyBasicPanelCommand(actions, command);
}

function applySelectionEditCommand(
  actions: PanelCommandTarget,
  command: SelectionEditCommand,
): void {
  if (command.type === "updateSelectionFormat") {
    actions.updateSelectedBlocks(command.patch);
  } else {
    actions.adjustSelectedBlocksFontSize(command.adjustment);
  }
}

function applyBasicPanelCommand(
  actions: PanelCommandTarget,
  command: Exclude<
    Parameters<typeof applyPanelCommand>[1],
    SelectionEditCommand
  >,
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

function isSelectionEditCommand(
  command: Parameters<typeof applyPanelCommand>[1],
): command is SelectionEditCommand {
  return (
    command.type === "updateSelectionFormat" ||
    command.type === "adjustSelectionFontSize"
  );
}

function isStaleSelectionCommand(
  command: PanelCommand,
  selectionKey: string,
): boolean {
  return command.type === "updateSelectionFormat" ||
    command.type === "adjustSelectionFontSize" ||
    command.type === "applyStylePreset" ||
    command.type === "createStylePreset" ||
    command.type === "overwriteStylePreset"
    ? command.selectionKey !== selectionKey
    : false;
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
    command.type === "removeBubbleLayout"
    ? command.blockId !== selectedBlockId
    : false;
}
