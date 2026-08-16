import React from "react";
import { useTranslation } from "react-i18next";
import type {
  BlockFormatDefaults,
  BlockFormatGroupId,
} from "../../../../shared/blockFormat";
import type { BlockStylePreset } from "../../../../shared/blockStylePresets";
import type { GatherTextDirectFormatValues } from "../../lib/gatherTextDirectFormatModel";
import { resolveEffectiveTextOutlineWidthPx } from "../../../../shared/textOutline";
import { toast } from "../../lib/toastStore";
import type { PresetGroupAvailability } from "./PresetGroupControl";
import {
  resolveStylePresetEditorValues,
  setStylePresetGroupEnabled,
  updateStylePresetFromEditor,
  type StylePresetEditorValues,
} from "./stylePresetEditing";

type PresetDispatch = React.Dispatch<React.SetStateAction<BlockStylePreset[]>>;

export type FormatDefaultsEditorModel = {
  activePreset: BlockStylePreset | undefined;
  editorValues: StylePresetEditorValues;
  exampleText: string;
  presetGroupAvailability: PresetGroupAvailability | undefined;
  previewValues: GatherTextDirectFormatValues;
  setExampleText: React.Dispatch<React.SetStateAction<string>>;
  togglePresetGroup: (groupId: BlockFormatGroupId) => void;
  updateEditor: (patch: Partial<StylePresetEditorValues>) => void;
};

export function useFormatDefaultsEditor({
  activePresetId,
  defaults,
  presets,
  onDefaultsChange,
  onPresetsChange,
}: {
  activePresetId: string | null;
  defaults: BlockFormatDefaults;
  presets: BlockStylePreset[];
  onDefaultsChange: (patch: Partial<BlockFormatDefaults>) => void;
  onPresetsChange: PresetDispatch;
}): FormatDefaultsEditorModel {
  const { t } = useTranslation("components");
  const [exampleText, setExampleText] = React.useState(() =>
    t("gatherText.previewTextDefault"),
  );
  const activePreset = presets.find(({ id }) => id === activePresetId);
  const editorValues = React.useMemo<StylePresetEditorValues>(
    () =>
      activePreset
        ? resolveStylePresetEditorValues(defaults, activePreset)
        : { ...defaults, rotationDeg: 0 },
    [activePreset, defaults],
  );
  const previewValues = React.useMemo(
    () => createPreviewValues(editorValues),
    [editorValues],
  );
  const presetGroupAvailability = React.useMemo(
    () => createPresetGroupAvailability(activePreset, t),
    [activePreset, t],
  );
  const updateEditor = useFormatEditorUpdate({
    activePreset,
    defaults,
    onDefaultsChange,
    onPresetsChange,
  });
  const togglePresetGroup = usePresetGroupToggle({
    activePreset,
    defaults,
    onPresetsChange,
    warning: t("stylePresets.minimumGroupRequired"),
  });
  return {
    activePreset,
    editorValues,
    exampleText,
    presetGroupAvailability,
    previewValues,
    setExampleText,
    togglePresetGroup,
    updateEditor,
  };
}

function createPresetGroupAvailability(
  activePreset: BlockStylePreset | undefined,
  t: (key: string) => string,
): PresetGroupAvailability | undefined {
  return activePreset
    ? {
        enabledGroups: new Set(activePreset.groupIds),
        disabledTooltip: t("stylePresets.disabledGroupTooltip"),
      }
    : undefined;
}

function useFormatEditorUpdate({
  activePreset,
  defaults,
  onDefaultsChange,
  onPresetsChange,
}: {
  activePreset: BlockStylePreset | undefined;
  defaults: BlockFormatDefaults;
  onDefaultsChange: (patch: Partial<BlockFormatDefaults>) => void;
  onPresetsChange: PresetDispatch;
}): FormatDefaultsEditorModel["updateEditor"] {
  return React.useCallback(
    (patch) => {
      if (!activePreset) {
        const { rotationDeg: _rotationDeg, ...defaultsPatch } = patch;
        onDefaultsChange(defaultsPatch);
        return;
      }
      onPresetsChange((current) =>
        current.map((preset) =>
          preset.id === activePreset.id
            ? updateStylePresetFromEditor(preset, defaults, patch)
            : preset,
        ),
      );
    },
    [activePreset, defaults, onDefaultsChange, onPresetsChange],
  );
}

function usePresetGroupToggle({
  activePreset,
  defaults,
  onPresetsChange,
  warning,
}: {
  activePreset: BlockStylePreset | undefined;
  defaults: BlockFormatDefaults;
  onPresetsChange: PresetDispatch;
  warning: string;
}): FormatDefaultsEditorModel["togglePresetGroup"] {
  return React.useCallback(
    (groupId) => {
      if (!activePreset) return;
      if (
        activePreset.groupIds.length === 1 &&
        activePreset.groupIds.includes(groupId)
      ) {
        toast.warn(warning);
        return;
      }
      onPresetsChange((current) =>
        current.map((preset) =>
          preset.id === activePreset.id
            ? setStylePresetGroupEnabled(
                preset,
                defaults,
                groupId,
                !preset.groupIds.includes(groupId),
              )
            : preset,
        ),
      );
    },
    [activePreset, defaults, onPresetsChange, warning],
  );
}

function createPreviewValues(
  value: StylePresetEditorValues,
): GatherTextDirectFormatValues {
  return {
    fontFamily: value.fontFamily,
    fontSizePx: value.fontSizePx,
    autoFitText: value.autoFitText,
    textAlign: value.textAlign,
    renderDirection:
      value.renderDirection === "vertical" ? "vertical" : "horizontal",
    wordBreak: value.wordBreak,
    bold: value.bold,
    italic: value.italic,
    lineHeight: value.lineHeight,
    letterSpacing: value.letterSpacing,
    fontWidthScale: value.fontWidthScale,
    textColor: value.textColor,
    textOpacity: value.textOpacity,
    outlineColor: value.outlineColor,
    outlineWidthPx: value.outlineEnabled
      ? resolveEffectiveTextOutlineWidthPx(value, value.fontSizePx)
      : 0,
    rotationDeg: value.rotationDeg,
  };
}
