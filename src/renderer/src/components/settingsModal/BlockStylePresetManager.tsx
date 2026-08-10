import React from "react";
import { IconChevronRight, IconPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { BlockFormatDefaults } from "../../../../shared/blockFormat";
import {
  createBlockStylePresetFromDefaults,
  MAX_BLOCK_STYLE_PRESETS,
  type BlockStylePreset,
  type BlockStylePresetGroup,
} from "../../../../shared/blockStylePresets";
import { useFonts } from "../../fonts/useFonts";
import {
  PresetManagerScreen,
  type PresetFontDetail,
} from "./stylePresetManager/PresetManagerScreen";
import { BlockStylePresetTabs } from "./BlockStylePresetTabs";

export function BlockStylePresetManager({
  activePresetId = null,
  defaults,
  groups = [],
  presets,
  onActivePresetChange = () => undefined,
  onChange,
  onGroupsChange = () => undefined,
}: {
  activePresetId?: string | null;
  defaults: BlockFormatDefaults;
  groups?: BlockStylePresetGroup[];
  presets: BlockStylePreset[];
  onActivePresetChange?: (presetId: string | null) => void;
  onChange: React.Dispatch<React.SetStateAction<BlockStylePreset[]>>;
  onGroupsChange?: React.Dispatch<
    React.SetStateAction<BlockStylePresetGroup[]>
  >;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const model = useBlockStylePresetManagerModel({
    activePresetId,
    defaults,
    groups,
    presets,
    onActivePresetChange,
    onChange,
  });

  return (
    <section className="style-preset-manager">
      <div className="style-preset-manager-heading">
        <h3>{t("stylePresets.title")}</h3>
        <span className="style-preset-manager-count" aria-hidden="true">
          {presets.length}
        </span>
      </div>
      <BlockStylePresetTabs
        activePresetId={activePresetId}
        expandedGroupId={model.expandedGroupId}
        groups={groups}
        presets={presets}
        tabListRef={model.tabListRef}
        onActivePresetChange={onActivePresetChange}
        onExpandedGroupChange={model.setExpandedGroupId}
      />
      <button
        type="button"
        className="style-preset-quick-add"
        aria-label={t("stylePresets.createQuick")}
        title={t("stylePresets.createQuick")}
        disabled={presets.length >= MAX_BLOCK_STYLE_PRESETS}
        onClick={model.addPreset}
      >
        <IconPlus size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="style-preset-manager-open"
        onClick={() => model.setManagerOpen(true)}
      >
        <span>{t("stylePresets.manage")}</span>
        <IconChevronRight size={16} aria-hidden="true" />
      </button>
      {model.managerOpen ? (
        <PresetManagerScreen
          defaults={defaults}
          fontDetails={model.fontDetails}
          groups={groups}
          initialSelectedPresetId={activePresetId}
          presets={presets}
          onChange={onChange}
          onClose={() => model.setManagerOpen(false)}
          onGroupsChange={onGroupsChange}
          onPresetSelected={onActivePresetChange}
        />
      ) : null}
    </section>
  );
}

function useBlockStylePresetManagerModel({
  activePresetId,
  defaults,
  groups,
  presets,
  onActivePresetChange,
  onChange,
}: Pick<
  Parameters<typeof BlockStylePresetManager>[0],
  | "activePresetId"
  | "defaults"
  | "groups"
  | "presets"
  | "onActivePresetChange"
  | "onChange"
>) {
  const { t } = useTranslation("components");
  const { options: fontOptions } = useFonts();
  const [managerOpen, setManagerOpen] = React.useState(false);
  const [expandedGroupId, setExpandedGroupId] = React.useState<string | null>(
    null,
  );
  const tabListRef = React.useRef<HTMLDivElement | null>(null);
  const fontDetails = React.useMemo(
    () =>
      new Map<string, PresetFontDetail>(
        fontOptions.map((font) => [
          font.id,
          { cssFamily: font.cssFamily, label: font.label },
        ]),
      ),
    [fontOptions],
  );
  React.useEffect(() => {
    if (expandedGroupId && !groups?.some(({ id }) => id === expandedGroupId)) {
      setExpandedGroupId(null);
    }
  }, [expandedGroupId, groups]);
  React.useEffect(() => {
    const targetId = activePresetId ?? "defaults";
    const activeTab = Array.from(
      tabListRef.current?.querySelectorAll<HTMLElement>(
        "[data-style-preset-tab]",
      ) ?? [],
    ).find((candidate) => candidate.dataset.stylePresetTab === targetId);
    activeTab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activePresetId, expandedGroupId]);
  const addPreset = (): void => {
    if (presets.length >= MAX_BLOCK_STYLE_PRESETS) return;
    const created = createBlockStylePresetFromDefaults({
      defaults,
      name: t("stylePresets.untitled"),
      pinned: true,
    });
    onChange((current) =>
      current.length >= MAX_BLOCK_STYLE_PRESETS
        ? current
        : [...current, created],
    );
    onActivePresetChange?.(created.id);
  };
  return {
    addPreset,
    expandedGroupId,
    fontDetails,
    managerOpen,
    setExpandedGroupId,
    setManagerOpen,
    tabListRef,
  };
}
