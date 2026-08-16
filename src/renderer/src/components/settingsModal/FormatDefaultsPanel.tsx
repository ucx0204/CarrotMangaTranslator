import React from "react";
import { useTranslation } from "react-i18next";
import {
  MAX_BUBBLE_LAYOUT_PADDING_RATIO,
  MIN_BUBBLE_LAYOUT_PADDING_RATIO,
} from "../../../../shared/bubbleLayoutSettings";
import type { BlockFormatDefaults } from "../../../../shared/settingsTypes";
import {
  ALL_BLOCK_FORMAT_GROUP_IDS,
  type BlockFormatGroupId,
} from "../../../../shared/blockFormat";
import { BlockFormatPreview } from "../blockFormat/BlockFormatPreview";
import { BlockFormatSectionHeading as DirectSectionHeading } from "../blockFormat/BlockFormatPrimitives";
import { FieldSlider } from "../ui/FieldSlider";
import {
  FormatDefaultsColorSection,
  FormatDefaultsFineTuningSection,
} from "./FormatDefaultsDetailSections";
import { TextEffectControls } from "../EditorColorGroup";
import { PresetGroupControl } from "./PresetGroupControl";
import type {
  BlockStylePreset,
  BlockStylePresetGroup,
} from "../../../../shared/blockStylePresets";
import { BlockStylePresetManager } from "./BlockStylePresetManager";
import { FormatDefaultsTypographySection } from "./FormatDefaultsTypographySection";
import {
  useFormatDefaultsEditor,
  type FormatDefaultsEditorModel,
} from "./useFormatDefaultsEditor";

export type FormatDefaultsPanelProps = {
  activePresetId?: string | null;
  bubbleLayoutPaddingRatio: number;
  value: BlockFormatDefaults;
  stylePresets?: BlockStylePreset[];
  stylePresetGroups?: BlockStylePresetGroup[];
  onActivePresetChange?: (presetId: string | null) => void;
  onBubbleLayoutPaddingRatioChange: (value: number) => void;
  onChange: (patch: Partial<BlockFormatDefaults>) => void;
  onStylePresetsChange?: React.Dispatch<
    React.SetStateAction<BlockStylePreset[]>
  >;
  onStylePresetGroupsChange?: React.Dispatch<
    React.SetStateAction<BlockStylePresetGroup[]>
  >;
};

export function FormatDefaultsPanel({
  activePresetId = null,
  bubbleLayoutPaddingRatio,
  value,
  stylePresets = [],
  stylePresetGroups = [],
  onActivePresetChange = () => undefined,
  onBubbleLayoutPaddingRatioChange,
  onChange,
  onStylePresetsChange = () => undefined,
  onStylePresetGroupsChange = () => undefined,
}: FormatDefaultsPanelProps): React.JSX.Element {
  const editor = useFormatDefaultsEditor({
    activePresetId,
    defaults: value,
    presets: stylePresets,
    onDefaultsChange: onChange,
    onPresetsChange: onStylePresetsChange,
  });

  return (
    <div className="format-settings-stack">
      <FormatDefaultsEditor
        bubbleLayoutPaddingRatio={bubbleLayoutPaddingRatio}
        editor={editor}
        onBubbleLayoutPaddingRatioChange={onBubbleLayoutPaddingRatioChange}
      />
      <BlockStylePresetManager
        activePresetId={editor.activePreset?.id ?? null}
        defaults={value}
        groups={stylePresetGroups}
        presets={stylePresets}
        onActivePresetChange={onActivePresetChange}
        onChange={onStylePresetsChange}
        onGroupsChange={onStylePresetGroupsChange}
      />
    </div>
  );
}

function FormatDefaultsEditor({
  bubbleLayoutPaddingRatio,
  editor,
  onBubbleLayoutPaddingRatioChange,
}: {
  bubbleLayoutPaddingRatio: number;
  editor: FormatDefaultsEditorModel;
  onBubbleLayoutPaddingRatioChange: (value: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const activePreset = editor.activePreset;
  return (
    <div className="format-defaults format-defaults-editor">
      <BlockFormatPreview
        exampleText={editor.exampleText}
        values={editor.previewValues}
        title={t("gatherText.previewTitle")}
        description=""
        exampleLabel={t("gatherText.previewTextLabel")}
        placeholder={t("gatherText.previewTextPlaceholder")}
        autoFitLabel={t("gatherText.autoFitBadge")}
        onExampleTextChange={editor.setExampleText}
      />
      <div className="format-defaults-editor-controls">
        <FormatDefaultsTypographySection
          allowAutoDirection={!activePreset}
          presetGroups={editor.presetGroupAvailability}
          value={editor.editorValues}
          onChange={editor.updateEditor}
        />
        <FormatDefaultsColorSection
          presetGroups={editor.presetGroupAvailability}
          value={editor.editorValues}
          onChange={editor.updateEditor}
        />
        <FormatDefaultsFineTuningSection
          presetGroups={editor.presetGroupAvailability}
          value={editor.editorValues}
          rotationDeg={
            activePreset ? editor.editorValues.rotationDeg : undefined
          }
          onChange={editor.updateEditor}
          onRotationChange={
            activePreset
              ? (rotationDeg) => editor.updateEditor({ rotationDeg })
              : undefined
          }
        />
        {activePreset ? <PresetTextEffectSection editor={editor} /> : null}
        {!activePreset ? (
          <BubbleLayoutPaddingSection
            value={bubbleLayoutPaddingRatio}
            onChange={onBubbleLayoutPaddingRatioChange}
          />
        ) : null}
        {activePreset ? (
          <PresetApplicationGroups
            preset={activePreset}
            onToggleGroup={editor.togglePresetGroup}
          />
        ) : null}
      </div>
    </div>
  );
}

function PresetTextEffectSection({
  editor,
}: {
  editor: FormatDefaultsEditorModel;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="gather-direct-editor-section">
      <DirectSectionHeading title={t("format.textEffect.title")} />
      <PresetGroupControl
        availability={editor.presetGroupAvailability}
        groupId="effect"
      >
        <TextEffectControls
          disabled={false}
          effect={editor.editorValues.textEffect}
          onChange={(textEffect) => editor.updateEditor({ textEffect })}
        />
      </PresetGroupControl>
    </section>
  );
}

function BubbleLayoutPaddingSection({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="gather-direct-editor-section">
      <DirectSectionHeading
        title={t("settings.format.bubbleLayout.title")}
        description={t("settings.format.bubbleLayout.description")}
      />
      <FieldSlider
        className="format-defaults-bubble-padding-slider"
        label={t("settings.format.bubbleLayout.padding")}
        valueLabel={`${Math.round(value * 100)}%`}
        min={MIN_BUBBLE_LAYOUT_PADDING_RATIO}
        max={MAX_BUBBLE_LAYOUT_PADDING_RATIO}
        step={0.01}
        value={value}
        onChange={(event) =>
          onChange(Math.round(Number(event.target.value) * 100) / 100)
        }
      />
    </section>
  );
}

function PresetApplicationGroups({
  preset,
  onToggleGroup,
}: {
  preset: BlockStylePreset;
  onToggleGroup: (groupId: BlockFormatGroupId) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="gather-direct-editor-section style-preset-application-groups">
      <div className="style-preset-editing-context-copy">
        <strong>{t("stylePresets.includedGroups")}</strong>
        <span>
          {t("stylePresets.includedGroupsHint", {
            count: preset.groupIds.length,
          })}
        </span>
      </div>
      <div
        className="style-preset-editing-groups"
        role="group"
        aria-label={t("stylePresets.includedGroups")}
      >
        {ALL_BLOCK_FORMAT_GROUP_IDS.map((groupId) => {
          const included = preset.groupIds.includes(groupId);
          return (
            <button
              key={groupId}
              type="button"
              aria-pressed={included}
              onClick={() => onToggleGroup(groupId)}
            >
              {t(`formatBatch.groups.${groupId}`)}
            </button>
          );
        })}
      </div>
    </section>
  );
}
