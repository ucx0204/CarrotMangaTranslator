import React from "react";
import {
  IconArrowDown,
  IconArrowUp,
  IconFolder,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  MAX_BLOCK_STYLE_PRESET_GROUP_NAME_LENGTH,
  type BlockStylePreset,
  type BlockStylePresetGroup,
} from "../../../../../shared/blockStylePresets";

type PresetLibraryProps = {
  groups: BlockStylePresetGroup[];
  missingFontById: ReadonlyMap<string, boolean>;
  presets: BlockStylePreset[];
  selectedPresetId: string;
  onDeleteGroup: (groupId: string) => void;
  onMoveGroup: (groupId: string, direction: -1 | 1) => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onSelect: (presetId: string) => void;
};

export function PresetLibrary(props: PresetLibraryProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const empty = props.presets.length === 0 && props.groups.length === 0;
  return (
    <div
      className="style-preset-library"
      role="listbox"
      aria-label={t("stylePresets.title")}
    >
      {empty ? (
        <div className="style-preset-library-empty">
          {t("stylePresets.empty")}
        </div>
      ) : (
        <PresetLibrarySections {...props} />
      )}
    </div>
  );
}

function PresetLibrarySections({
  groups,
  missingFontById,
  presets,
  selectedPresetId,
  onDeleteGroup,
  onMoveGroup,
  onRenameGroup,
  onSelect,
}: PresetLibraryProps): React.JSX.Element {
  const ungrouped = presets.filter((preset) => !preset.groupId);
  return (
    <>
      {ungrouped.length > 0 ? (
        <UngroupedPresetSection
          groupsExist={groups.length > 0}
          missingFontById={missingFontById}
          presets={ungrouped}
          selectedPresetId={selectedPresetId}
          onSelect={onSelect}
        />
      ) : null}
      {groups.map((group, groupIndex) => (
        <PresetLibraryGroup
          key={group.id}
          canMoveDown={groupIndex < groups.length - 1}
          canMoveUp={groupIndex > 0}
          group={group}
          missingFontById={missingFontById}
          presets={presets.filter((preset) => preset.groupId === group.id)}
          selectedPresetId={selectedPresetId}
          onDeleteGroup={onDeleteGroup}
          onMoveGroup={onMoveGroup}
          onRenameGroup={onRenameGroup}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

function UngroupedPresetSection({
  groupsExist,
  missingFontById,
  presets,
  selectedPresetId,
  onSelect,
}: {
  groupsExist: boolean;
  missingFontById: ReadonlyMap<string, boolean>;
  presets: BlockStylePreset[];
  selectedPresetId: string;
  onSelect: (presetId: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="style-preset-library-section">
      {groupsExist ? (
        <div className="style-preset-library-section-label">
          {t("stylePresets.ungrouped")}
        </div>
      ) : null}
      {presets.map((preset) => (
        <PresetLibraryItem
          key={preset.id}
          missingFont={missingFontById.get(preset.id) ?? false}
          preset={preset}
          selected={preset.id === selectedPresetId}
          onSelect={() => onSelect(preset.id)}
        />
      ))}
    </div>
  );
}

function PresetLibraryGroup({
  canMoveDown,
  canMoveUp,
  group,
  missingFontById,
  presets,
  selectedPresetId,
  onDeleteGroup,
  onMoveGroup,
  onRenameGroup,
  onSelect,
}: {
  canMoveDown: boolean;
  canMoveUp: boolean;
  group: BlockStylePresetGroup;
  missingFontById: ReadonlyMap<string, boolean>;
  presets: BlockStylePreset[];
  selectedPresetId: string;
  onDeleteGroup: (groupId: string) => void;
  onMoveGroup: (groupId: string, direction: -1 | 1) => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onSelect: (presetId: string) => void;
}): React.JSX.Element {
  return (
    <section className="style-preset-library-group">
      <PresetGroupHeader
        canMoveDown={canMoveDown}
        canMoveUp={canMoveUp}
        group={group}
        presetCount={presets.length}
        onDeleteGroup={onDeleteGroup}
        onMoveGroup={onMoveGroup}
        onRenameGroup={onRenameGroup}
      />
      <div className="style-preset-library-group-items">
        <PresetGroupItems
          missingFontById={missingFontById}
          presets={presets}
          selectedPresetId={selectedPresetId}
          onSelect={onSelect}
        />
      </div>
    </section>
  );
}

function PresetGroupHeader({
  canMoveDown,
  canMoveUp,
  group,
  presetCount,
  onDeleteGroup,
  onMoveGroup,
  onRenameGroup,
}: {
  canMoveDown: boolean;
  canMoveUp: boolean;
  group: BlockStylePresetGroup;
  presetCount: number;
  onDeleteGroup: (groupId: string) => void;
  onMoveGroup: (groupId: string, direction: -1 | 1) => void;
  onRenameGroup: (groupId: string, name: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="style-preset-library-group-header">
      <IconFolder size={15} aria-hidden="true" />
      <input
        data-style-preset-group-name={group.id}
        aria-label={t("stylePresets.groupName")}
        maxLength={MAX_BLOCK_STYLE_PRESET_GROUP_NAME_LENGTH}
        value={group.name}
        onChange={(event) => onRenameGroup(group.id, event.target.value)}
        onBlur={(event) =>
          onRenameGroup(
            group.id,
            event.target.value.trim() || t("stylePresets.untitledGroup"),
          )
        }
      />
      <small>{presetCount}</small>
      <GroupHeaderAction
        disabled={!canMoveUp}
        label={t("stylePresets.moveUp")}
        onClick={() => onMoveGroup(group.id, -1)}
      >
        <IconArrowUp size={14} aria-hidden="true" />
      </GroupHeaderAction>
      <GroupHeaderAction
        disabled={!canMoveDown}
        label={t("stylePresets.moveDown")}
        onClick={() => onMoveGroup(group.id, 1)}
      >
        <IconArrowDown size={14} aria-hidden="true" />
      </GroupHeaderAction>
      <GroupHeaderAction
        danger
        disabled={false}
        label={t("stylePresets.releaseGroup")}
        onClick={() => onDeleteGroup(group.id)}
      >
        <IconTrash size={14} aria-hidden="true" />
      </GroupHeaderAction>
    </div>
  );
}

function PresetGroupItems({
  missingFontById,
  presets,
  selectedPresetId,
  onSelect,
}: {
  missingFontById: ReadonlyMap<string, boolean>;
  presets: BlockStylePreset[];
  selectedPresetId: string;
  onSelect: (presetId: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  if (presets.length === 0) return <span>{t("stylePresets.emptyGroup")}</span>;
  return (
    <>
      {presets.map((preset) => (
        <PresetLibraryItem
          key={preset.id}
          grouped
          missingFont={missingFontById.get(preset.id) ?? false}
          preset={preset}
          selected={preset.id === selectedPresetId}
          onSelect={() => onSelect(preset.id)}
        />
      ))}
    </>
  );
}

function PresetLibraryItem({
  grouped = false,
  missingFont,
  preset,
  selected,
  onSelect,
}: {
  grouped?: boolean;
  missingFont: boolean;
  preset: BlockStylePreset;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <button
      type="button"
      className="style-preset-library-item"
      data-grouped={grouped}
      aria-selected={selected}
      role="option"
      onClick={onSelect}
    >
      <span className="style-preset-library-name">{preset.name}</span>
      {preset.pinned ? (
        <span className="style-preset-library-badge">
          {t("stylePresets.pinned")}
        </span>
      ) : null}
      {missingFont ? (
        <span
          className="style-preset-library-warning"
          aria-label={t("stylePresets.missingFontShort")}
        >
          ⚠
        </span>
      ) : null}
    </button>
  );
}

function GroupHeaderAction({
  children,
  danger = false,
  disabled,
  label,
  onClick,
}: {
  children: React.ReactNode;
  danger?: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`style-preset-group-action ${danger ? "danger" : ""}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
