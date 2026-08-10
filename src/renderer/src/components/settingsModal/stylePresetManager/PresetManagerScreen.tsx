import React from "react";
import {
  IconArrowDown,
  IconArrowLeft,
  IconArrowUp,
  IconCopy,
  IconFolderPlus,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { BlockFormatDefaults } from "../../../../../shared/blockFormat";
import {
  MAX_BLOCK_STYLE_PRESET_GROUPS,
  MAX_BLOCK_STYLE_PRESETS,
  summarizeBlockStylePresets,
  type BlockStylePreset,
  type BlockStylePresetGroup,
} from "../../../../../shared/blockStylePresets";
import {
  PresetDefinitionPanel,
  type PresetFontDetail,
} from "./PresetDefinitionPanel";
import { PresetLibrary } from "./PresetLibrary";
import { usePresetManagerModel } from "./usePresetManagerModel";

export type { PresetFontDetail };

type PresetManagerScreenProps = {
  defaults: BlockFormatDefaults;
  fontDetails: ReadonlyMap<string, PresetFontDetail>;
  groups: BlockStylePresetGroup[];
  initialSelectedPresetId?: string | null;
  presets: BlockStylePreset[];
  onChange: React.Dispatch<React.SetStateAction<BlockStylePreset[]>>;
  onClose: () => void;
  onGroupsChange: React.Dispatch<React.SetStateAction<BlockStylePresetGroup[]>>;
  onPresetSelected?: (presetId: string | null) => void;
};

export function PresetManagerScreen(
  props: PresetManagerScreenProps,
): React.JSX.Element {
  const model = usePresetManagerModel(props);
  const missingFontById = new Map(
    summarizeBlockStylePresets(
      props.presets,
      new Set(props.fontDetails.keys()),
    ).map((summary) => [summary.id, summary.missingFont]),
  );
  return (
    <div className="style-preset-manager-screen">
      <PresetManagerHeader
        count={props.presets.length}
        groupCount={props.groups.length}
        onAdd={model.add}
        onAddGroup={model.addGroup}
        onClose={props.onClose}
      />
      <div className="style-preset-manager-workspace">
        <PresetLibrary
          groups={props.groups}
          missingFontById={missingFontById}
          presets={props.presets}
          selectedPresetId={model.selectedPreset?.id ?? ""}
          onDeleteGroup={model.deleteGroup}
          onMoveGroup={model.moveGroup}
          onRenameGroup={model.renameGroup}
          onSelect={model.select}
        />
        {model.selectedPreset ? (
          <PresetDefinitionPanel
            fontDetails={props.fontDetails}
            groups={props.groups}
            preset={model.selectedPreset}
            onPatch={model.patch}
          />
        ) : (
          <div className="style-preset-definition-empty" aria-hidden="true" />
        )}
      </div>
      <PresetManagerActions
        canMoveDown={model.canMoveDown}
        canMoveUp={model.canMoveUp}
        hasSelection={Boolean(model.selectedPreset)}
        limitReached={props.presets.length >= MAX_BLOCK_STYLE_PRESETS}
        onDelete={model.delete}
        onDuplicate={model.duplicate}
        onMove={model.move}
      />
    </div>
  );
}

function PresetManagerHeader({
  count,
  groupCount,
  onAdd,
  onAddGroup,
  onClose,
}: {
  count: number;
  groupCount: number;
  onAdd: () => void;
  onAddGroup: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <header className="style-preset-manager-screen-header">
      <button
        type="button"
        className="style-preset-manager-back"
        onClick={onClose}
      >
        <IconArrowLeft size={17} aria-hidden="true" />
        <span>{t("stylePresets.backToEditor")}</span>
      </button>
      <div className="style-preset-manager-screen-title">
        <h3>{t("stylePresets.manage")}</h3>
        <span>{count}</span>
      </div>
      <div className="style-preset-manager-create-actions">
        <button
          type="button"
          className="style-preset-library-create secondary"
          disabled={groupCount >= MAX_BLOCK_STYLE_PRESET_GROUPS}
          onClick={onAddGroup}
        >
          <IconFolderPlus size={16} aria-hidden="true" />
          <span>{t("stylePresets.addGroup")}</span>
        </button>
        <button
          type="button"
          className="style-preset-library-create"
          disabled={count >= MAX_BLOCK_STYLE_PRESETS}
          onClick={onAdd}
        >
          <IconPlus size={16} aria-hidden="true" />
          <span>{t("common.add")}</span>
        </button>
      </div>
    </header>
  );
}

function PresetManagerActions({
  canMoveDown,
  canMoveUp,
  hasSelection,
  limitReached,
  onDelete,
  onDuplicate,
  onMove,
}: {
  canMoveDown: boolean;
  canMoveUp: boolean;
  hasSelection: boolean;
  limitReached: boolean;
  onDelete: () => void;
  onDuplicate: () => void;
  onMove: (direction: -1 | 1) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="style-preset-library-actions">
      <LibraryAction
        label={t("stylePresets.moveUp")}
        disabled={!canMoveUp}
        icon={<IconArrowUp size={15} aria-hidden="true" />}
        onClick={() => onMove(-1)}
      />
      <LibraryAction
        label={t("stylePresets.moveDown")}
        disabled={!canMoveDown}
        icon={<IconArrowDown size={15} aria-hidden="true" />}
        onClick={() => onMove(1)}
      />
      <LibraryAction
        label={t("common.duplicate")}
        disabled={!hasSelection || limitReached}
        icon={<IconCopy size={15} aria-hidden="true" />}
        onClick={onDuplicate}
      />
      <LibraryAction
        danger
        label={t("common.delete")}
        disabled={!hasSelection}
        icon={<IconTrash size={15} aria-hidden="true" />}
        onClick={onDelete}
      />
    </div>
  );
}

function LibraryAction({
  danger = false,
  disabled,
  icon,
  label,
  onClick,
}: {
  danger?: boolean;
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`style-preset-library-action ${danger ? "danger" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
