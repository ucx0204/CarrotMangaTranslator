import React from "react";
import {
  IconArrowDown,
  IconArrowLeft,
  IconArrowUp,
  IconCopy,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { BlockFormatDefaults } from "../../../../../shared/blockFormat";
import {
  createBlockStylePresetFromDefaults,
  createBlockStylePresetId,
  MAX_BLOCK_STYLE_PRESET_NAME_LENGTH,
  MAX_BLOCK_STYLE_PRESETS,
  summarizeBlockStylePresets,
  type BlockStylePreset,
} from "../../../../../shared/blockStylePresets";
import {
  PresetDefinitionPanel,
  type PresetFontDetail,
} from "./PresetDefinitionPanel";

export type { PresetFontDetail };

type PresetManagerScreenProps = {
  defaults: BlockFormatDefaults;
  fontDetails: ReadonlyMap<string, PresetFontDetail>;
  presets: BlockStylePreset[];
  onChange: React.Dispatch<React.SetStateAction<BlockStylePreset[]>>;
  onClose: () => void;
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
        onAdd={model.add}
        onClose={props.onClose}
      />
      <div className="style-preset-manager-workspace">
        <PresetLibrary
          missingFontById={missingFontById}
          presets={props.presets}
          selectedPresetId={model.selectedPreset?.id ?? ""}
          onSelect={model.select}
        />
        {model.selectedPreset ? (
          <PresetDefinitionPanel
            fontDetails={props.fontDetails}
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

type PresetManagerModel = {
  selectedPreset: BlockStylePreset | undefined;
  canMoveDown: boolean;
  canMoveUp: boolean;
  add: () => void;
  delete: () => void;
  duplicate: () => void;
  move: (direction: -1 | 1) => void;
  patch: (patch: Partial<BlockStylePreset>) => void;
  select: (presetId: string) => void;
};

function usePresetManagerModel({
  defaults,
  presets,
  onChange,
}: PresetManagerScreenProps): PresetManagerModel {
  const { t } = useTranslation("components");
  const [requestedId, setRequestedId] = React.useState(
    () => presets[0]?.id ?? "",
  );
  const selectedId = presets.some((preset) => preset.id === requestedId)
    ? requestedId
    : (presets[0]?.id ?? "");
  const selectedIndex = presets.findIndex((preset) => preset.id === selectedId);
  const selectedPreset = presets[selectedIndex];
  const patch = (patchValue: Partial<BlockStylePreset>): void => {
    if (!selectedPreset) return;
    onChange((current) =>
      current.map((preset) =>
        preset.id === selectedPreset.id ? { ...preset, ...patchValue } : preset,
      ),
    );
  };
  const add = (): void => {
    if (presets.length >= MAX_BLOCK_STYLE_PRESETS) return;
    const created = createBlockStylePresetFromDefaults({
      defaults,
      name: t("stylePresets.untitled"),
      pinned: true,
    });
    setRequestedId(created.id);
    onChange((current) => appendPreset(current, created));
    window.requestAnimationFrame(focusPresetName);
  };
  const deletePreset = (): void => {
    if (!selectedPreset) return;
    setRequestedId(
      presets[selectedIndex + 1]?.id ?? presets[selectedIndex - 1]?.id ?? "",
    );
    onChange((current) =>
      current.filter((preset) => preset.id !== selectedPreset.id),
    );
  };
  const duplicate = (): void => {
    if (!selectedPreset || presets.length >= MAX_BLOCK_STYLE_PRESETS) return;
    const created = clonePreset(
      selectedPreset,
      t("stylePresets.duplicateName", { name: selectedPreset.name }),
    );
    setRequestedId(created.id);
    onChange((current) => appendPreset(current, created));
  };
  return {
    selectedPreset,
    canMoveDown: selectedIndex >= 0 && selectedIndex < presets.length - 1,
    canMoveUp: selectedIndex > 0,
    add,
    delete: deletePreset,
    duplicate,
    move: (direction) => {
      if (selectedPreset) {
        onChange((current) =>
          movePreset(current, selectedPreset.id, direction),
        );
      }
    },
    patch,
    select: setRequestedId,
  };
}

function PresetManagerHeader({
  count,
  onAdd,
  onClose,
}: {
  count: number;
  onAdd: () => void;
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
        <span>{t("stylePresets.back")}</span>
      </button>
      <div className="style-preset-manager-screen-title">
        <h3>{t("stylePresets.manage")}</h3>
        <span>{count}</span>
      </div>
      <button
        type="button"
        className="style-preset-library-create"
        disabled={count >= MAX_BLOCK_STYLE_PRESETS}
        onClick={onAdd}
      >
        <IconPlus size={16} aria-hidden="true" />
        <span>{t("common.add")}</span>
      </button>
    </header>
  );
}

function PresetLibrary({
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
  return (
    <div
      className="style-preset-library"
      role="listbox"
      aria-label={t("stylePresets.title")}
    >
      {presets.length === 0 ? (
        <div className="style-preset-library-empty">
          {t("stylePresets.empty")}
        </div>
      ) : (
        presets.map((preset) => (
          <PresetLibraryItem
            key={preset.id}
            missingFont={missingFontById.get(preset.id) ?? false}
            preset={preset}
            selected={preset.id === selectedPresetId}
            onSelect={() => onSelect(preset.id)}
          />
        ))
      )}
    </div>
  );
}

function PresetLibraryItem({
  missingFont,
  preset,
  selected,
  onSelect,
}: {
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

function appendPreset(
  presets: BlockStylePreset[],
  preset: BlockStylePreset,
): BlockStylePreset[] {
  return presets.length >= MAX_BLOCK_STYLE_PRESETS
    ? presets
    : [...presets, preset];
}

function focusPresetName(): void {
  const input = document.querySelector<HTMLInputElement>(
    ".style-preset-definition-name",
  );
  input?.focus();
  input?.select();
}

function clonePreset(
  preset: BlockStylePreset,
  duplicateName: string,
): BlockStylePreset {
  return {
    ...preset,
    id: createBlockStylePresetId(),
    name: duplicateName.slice(0, MAX_BLOCK_STYLE_PRESET_NAME_LENGTH),
    groupIds: [...preset.groupIds],
    format: { ...preset.format },
  };
}

function movePreset(
  presets: BlockStylePreset[],
  presetId: string,
  direction: -1 | 1,
): BlockStylePreset[] {
  const index = presets.findIndex((preset) => preset.id === presetId);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= presets.length) {
    return presets;
  }
  const next = [...presets];
  [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
  return next;
}
