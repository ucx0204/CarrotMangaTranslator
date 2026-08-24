import React from "react";
import { IconChevronDown, IconFolder } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type {
  BlockStylePreset,
  BlockStylePresetGroup,
} from "../../../../shared/blockStylePresets";

export function BlockStylePresetTabs({
  activePresetId,
  expandedGroupId,
  groups,
  presets,
  tabListRef,
  onActivePresetChange,
  onExpandedGroupChange,
}: {
  activePresetId: string | null;
  expandedGroupId: string | null;
  groups: BlockStylePresetGroup[];
  presets: BlockStylePreset[];
  tabListRef: React.RefObject<HTMLDivElement | null>;
  onActivePresetChange: (presetId: string | null) => void;
  onExpandedGroupChange: (groupId: string | null) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const ungroupedPresets = presets.filter((preset) => !preset.groupId);
  return (
    // A group, not a tablist: these buttons select which preset the panel below
    // edits, and expandable folders are interleaved with them. There is no
    // tabpanel per button, so claiming tab semantics would be a lie to AT.
    <div
      className="style-preset-tabs-scroll"
      role="group"
      aria-label={t("stylePresets.title")}
      ref={tabListRef}
    >
      <PresetTab
        active={!activePresetId}
        id="defaults"
        label={t("settings.tabs.format")}
        onClick={() => onActivePresetChange(null)}
      />
      {ungroupedPresets.map((preset) => (
        <PresetTab
          key={preset.id}
          active={preset.id === activePresetId}
          id={preset.id}
          label={preset.name}
          onClick={() => onActivePresetChange(preset.id)}
        />
      ))}
      {groups.map((group) => (
        <PresetGroupTabs
          key={group.id}
          activePresetId={activePresetId}
          expanded={expandedGroupId === group.id}
          group={group}
          presets={presets.filter((preset) => preset.groupId === group.id)}
          onActivePresetChange={onActivePresetChange}
          onToggle={() =>
            onExpandedGroupChange(
              expandedGroupId === group.id ? null : group.id,
            )
          }
        />
      ))}
    </div>
  );
}

function PresetGroupTabs({
  activePresetId,
  expanded,
  group,
  presets,
  onActivePresetChange,
  onToggle,
}: {
  activePresetId: string | null;
  expanded: boolean;
  group: BlockStylePresetGroup;
  presets: BlockStylePreset[];
  onActivePresetChange: (presetId: string | null) => void;
  onToggle: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const containsActive = presets.some((preset) => preset.id === activePresetId);
  return (
    <>
      <button
        type="button"
        className="style-preset-group-tab"
        data-expanded={expanded}
        data-contains-active={containsActive}
        aria-expanded={expanded}
        title={group.name}
        onClick={onToggle}
      >
        <IconFolder size={15} aria-hidden="true" />
        <span>{group.name}</span>
        <small>{presets.length}</small>
        <IconChevronDown
          className={expanded ? "open" : ""}
          size={14}
          aria-hidden="true"
        />
      </button>
      {expanded ? (
        <span className="style-preset-group-children">
          {presets.length > 0 ? (
            presets.map((preset) => (
              <PresetTab
                key={preset.id}
                active={preset.id === activePresetId}
                grouped
                id={preset.id}
                label={preset.name}
                onClick={() => onActivePresetChange(preset.id)}
              />
            ))
          ) : (
            <span className="style-preset-group-empty">
              {t("stylePresets.emptyGroup")}
            </span>
          )}
        </span>
      ) : null}
    </>
  );
}

function PresetTab({
  active,
  grouped = false,
  id,
  label,
  onClick,
}: {
  active: boolean;
  grouped?: boolean;
  id: string;
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="style-preset-tab"
      data-grouped={grouped}
      data-style-preset-tab={id}
      aria-pressed={active}
      title={label}
      onClick={onClick}
    >
      <span>{label}</span>
    </button>
  );
}
