import React from "react";
import { useTranslation } from "react-i18next";
import type { BlockFormatDefaults } from "../../../../../shared/blockFormat";
import {
  createBlockStylePresetFromDefaults,
  createBlockStylePresetGroup,
  createBlockStylePresetId,
  MAX_BLOCK_STYLE_PRESET_NAME_LENGTH,
  MAX_BLOCK_STYLE_PRESET_GROUPS,
  MAX_BLOCK_STYLE_PRESETS,
  type BlockStylePreset,
  type BlockStylePresetGroup,
} from "../../../../../shared/blockStylePresets";

type PresetDispatch = React.Dispatch<React.SetStateAction<BlockStylePreset[]>>;
type GroupDispatch = React.Dispatch<
  React.SetStateAction<BlockStylePresetGroup[]>
>;

export type PresetManagerModel = {
  selectedPreset: BlockStylePreset | undefined;
  canMoveDown: boolean;
  canMoveUp: boolean;
  add: () => void;
  addGroup: () => void;
  delete: () => void;
  deleteGroup: (groupId: string) => void;
  duplicate: () => void;
  move: (direction: -1 | 1) => void;
  moveGroup: (groupId: string, direction: -1 | 1) => void;
  patch: (patch: Partial<BlockStylePreset>) => void;
  renameGroup: (groupId: string, name: string) => void;
  select: (presetId: string) => void;
};

export function usePresetManagerModel({
  defaults,
  groups,
  initialSelectedPresetId,
  presets,
  onChange,
  onGroupsChange,
  onPresetSelected,
}: {
  defaults: BlockFormatDefaults;
  groups: BlockStylePresetGroup[];
  initialSelectedPresetId?: string | null;
  presets: BlockStylePreset[];
  onChange: PresetDispatch;
  onGroupsChange: GroupDispatch;
  onPresetSelected?: (presetId: string | null) => void;
}): PresetManagerModel {
  const { t } = useTranslation("components");
  const [requestedId, setRequestedId] = React.useState(
    () => initialSelectedPresetId ?? presets[0]?.id ?? "",
  );
  const selection = resolvePresetSelection(presets, requestedId);
  const presetActions = createPresetActions({
    defaults,
    duplicateLabel: (name) => t("stylePresets.duplicateName", { name }),
    onChange,
    onPresetSelected,
    presets,
    selection,
    setRequestedId,
    untitledLabel: t("stylePresets.untitled"),
  });
  const groupActions = createGroupActions({
    groups,
    onChange,
    onGroupsChange,
    untitledGroupLabel: t("stylePresets.untitledGroup"),
  });
  return {
    selectedPreset: selection.selectedPreset,
    canMoveDown: selection.canMoveDown,
    canMoveUp: selection.canMoveUp,
    ...presetActions,
    ...groupActions,
  };
}

type PresetSelection = {
  canMoveDown: boolean;
  canMoveUp: boolean;
  selectedIndex: number;
  selectedPreset: BlockStylePreset | undefined;
};

function resolvePresetSelection(
  presets: BlockStylePreset[],
  requestedId: string,
): PresetSelection {
  const selectedId = presets.some(({ id }) => id === requestedId)
    ? requestedId
    : (presets[0]?.id ?? "");
  const selectedIndex = presets.findIndex(({ id }) => id === selectedId);
  const selectedPreset = presets[selectedIndex];
  const siblingIds = selectedPreset
    ? presets
        .filter(({ groupId }) => groupId === selectedPreset.groupId)
        .map(({ id }) => id)
    : [];
  const siblingIndex = siblingIds.indexOf(selectedId);
  return {
    canMoveDown:
      siblingIndex >= 0 && siblingIndex < Math.max(0, siblingIds.length - 1),
    canMoveUp: siblingIndex > 0,
    selectedIndex,
    selectedPreset,
  };
}

function createPresetActions({
  defaults,
  duplicateLabel,
  onChange,
  onPresetSelected,
  presets,
  selection,
  setRequestedId,
  untitledLabel,
}: {
  defaults: BlockFormatDefaults;
  duplicateLabel: (name: string) => string;
  onChange: PresetDispatch;
  onPresetSelected?: (presetId: string | null) => void;
  presets: BlockStylePreset[];
  selection: PresetSelection;
  setRequestedId: React.Dispatch<React.SetStateAction<string>>;
  untitledLabel: string;
}): Pick<
  PresetManagerModel,
  "add" | "delete" | "duplicate" | "move" | "patch" | "select"
> {
  const select = (presetId: string): void => {
    setRequestedId(presetId);
    onPresetSelected?.(presetId);
  };
  return {
    add: () => {
      if (presets.length >= MAX_BLOCK_STYLE_PRESETS) return;
      const created = createBlockStylePresetFromDefaults({
        defaults,
        name: untitledLabel,
        pinned: true,
      });
      select(created.id);
      onChange((current) => appendPreset(current, created));
      window.requestAnimationFrame(focusPresetName);
    },
    delete: () => {
      if (!selection.selectedPreset) return;
      const nextId =
        presets[selection.selectedIndex + 1]?.id ??
        presets[selection.selectedIndex - 1]?.id ??
        "";
      setRequestedId(nextId);
      onPresetSelected?.(nextId || null);
      onChange((current) =>
        current.filter(({ id }) => id !== selection.selectedPreset?.id),
      );
    },
    duplicate: createDuplicatePresetAction({
      duplicateLabel,
      onChange,
      presets,
      selectedPreset: selection.selectedPreset,
      select,
    }),
    move: (direction) => {
      if (!selection.selectedPreset) return;
      onChange((current) =>
        movePresetWithinGroup(
          current,
          selection.selectedPreset?.id ?? "",
          direction,
        ),
      );
    },
    patch: (patch) => {
      if (!selection.selectedPreset) return;
      onChange((current) =>
        current.map((preset) =>
          preset.id === selection.selectedPreset?.id
            ? { ...preset, ...patch }
            : preset,
        ),
      );
    },
    select,
  };
}

function createDuplicatePresetAction({
  duplicateLabel,
  onChange,
  presets,
  selectedPreset,
  select,
}: {
  duplicateLabel: (name: string) => string;
  onChange: PresetDispatch;
  presets: BlockStylePreset[];
  selectedPreset: BlockStylePreset | undefined;
  select: (presetId: string) => void;
}): () => void {
  return () => {
    if (!selectedPreset || presets.length >= MAX_BLOCK_STYLE_PRESETS) return;
    const created = clonePreset(
      selectedPreset,
      duplicateLabel(selectedPreset.name),
    );
    select(created.id);
    onChange((current) => appendPreset(current, created));
  };
}

function createGroupActions({
  groups,
  onChange,
  onGroupsChange,
  untitledGroupLabel,
}: {
  groups: BlockStylePresetGroup[];
  onChange: PresetDispatch;
  onGroupsChange: GroupDispatch;
  untitledGroupLabel: string;
}): Pick<
  PresetManagerModel,
  "addGroup" | "deleteGroup" | "moveGroup" | "renameGroup"
> {
  return {
    addGroup: () => {
      if (groups.length >= MAX_BLOCK_STYLE_PRESET_GROUPS) return;
      const created = createBlockStylePresetGroup({ name: untitledGroupLabel });
      onGroupsChange((current) =>
        current.length >= MAX_BLOCK_STYLE_PRESET_GROUPS
          ? current
          : [...current, created],
      );
      window.requestAnimationFrame(() => focusGroupName(created.id));
    },
    deleteGroup: (groupId) => {
      onGroupsChange((current) => current.filter(({ id }) => id !== groupId));
      onChange((current) =>
        current.map((preset) => {
          if (preset.groupId !== groupId) return preset;
          const { groupId: _groupId, ...ungrouped } = preset;
          return ungrouped;
        }),
      );
    },
    moveGroup: (groupId, direction) => {
      onGroupsChange((current) => moveGroup(current, groupId, direction));
    },
    renameGroup: (groupId, name) => {
      onGroupsChange((current) =>
        current.map((group) =>
          group.id === groupId ? { ...group, name } : group,
        ),
      );
    },
  };
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

function focusGroupName(groupId: string): void {
  const input = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      "[data-style-preset-group-name]",
    ),
  ).find((candidate) => candidate.dataset.stylePresetGroupName === groupId);
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

function movePresetWithinGroup(
  presets: BlockStylePreset[],
  presetId: string,
  direction: -1 | 1,
): BlockStylePreset[] {
  const index = presets.findIndex(({ id }) => id === presetId);
  const selected = presets[index];
  if (!selected) return presets;
  const siblingIndices = presets.flatMap((preset, candidateIndex) =>
    preset.groupId === selected.groupId ? [candidateIndex] : [],
  );
  const siblingIndex = siblingIndices.indexOf(index);
  const targetIndex = siblingIndices[siblingIndex + direction];
  if (targetIndex === undefined) return presets;
  const next = [...presets];
  [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
  return next;
}

function moveGroup(
  groups: BlockStylePresetGroup[],
  groupId: string,
  direction: -1 | 1,
): BlockStylePresetGroup[] {
  const index = groups.findIndex(({ id }) => id === groupId);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= groups.length) {
    return groups;
  }
  const next = [...groups];
  [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
  return next;
}
