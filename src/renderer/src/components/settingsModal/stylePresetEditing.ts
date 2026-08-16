import {
  ALL_BLOCK_FORMAT_GROUP_IDS,
  type BlockFormatDefaults,
  type BlockFormatGroupId,
} from "../../../../shared/blockFormat";
import type { BlockStylePreset } from "../../../../shared/blockStylePresets";
import type { TranslationBlock } from "../../../../shared/textTypes";

export type StylePresetEditorValues = BlockFormatDefaults & {
  rotationDeg: number;
};

type EditorPatch = Partial<StylePresetEditorValues>;
type PresetFormat = BlockStylePreset["format"];
type EditorField = keyof StylePresetEditorValues;
type PresetFormatField = keyof PresetFormat;

const EDITOR_FIELDS_BY_GROUP: Record<
  BlockFormatGroupId,
  readonly EditorField[]
> = {
  font: ["fontFamily"],
  size: ["fontSizePx", "autoFitText"],
  align: ["textAlign"],
  wordBreak: ["wordBreak"],
  direction: ["renderDirection"],
  emphasis: ["bold", "italic"],
  lineSpacing: ["lineHeight"],
  letterSpacing: ["letterSpacing"],
  fontWidth: ["fontWidthScale"],
  color: ["textColor"],
  outline: [
    "outlineEnabled",
    "outlineColor",
    "outlineWidthPx",
    "outlineWidthScale",
  ],
  transform: ["rotationDeg", "textOpacity"],
};

const PRESET_FIELDS_BY_GROUP: Record<
  BlockFormatGroupId,
  readonly PresetFormatField[]
> = {
  font: ["fontFamily"],
  size: ["fontSizePx", "autoFitText"],
  align: ["textAlign"],
  wordBreak: ["wordBreak"],
  direction: ["renderDirection"],
  emphasis: ["bold", "italic"],
  lineSpacing: ["lineHeight"],
  letterSpacing: ["letterSpacing"],
  fontWidth: ["fontWidthScale"],
  color: ["textColor"],
  outline: ["outlineColor", "outlineWidthPx", "outlineWidthScale"],
  transform: ["rotationDeg", "textOpacity"],
};

export function resolveStylePresetEditorValues(
  defaults: BlockFormatDefaults,
  preset: BlockStylePreset,
): StylePresetEditorValues {
  const values: StylePresetEditorValues = {
    ...defaults,
    rotationDeg: 0,
  };
  for (const groupId of preset.groupIds) {
    Object.assign(
      values,
      buildEditorGroupValues(groupId, defaults, preset.format),
    );
  }
  return values;
}

function buildEditorGroupValues(
  groupId: BlockFormatGroupId,
  defaults: BlockFormatDefaults,
  format: PresetFormat,
): EditorPatch {
  const builders: Record<BlockFormatGroupId, () => EditorPatch> = {
    font: () =>
      "fontFamily" in format ? { fontFamily: format.fontFamily } : {},
    size: () => ({
      autoFitText: format.autoFitText ?? true,
      fontSizePx: format.fontSizePx ?? defaults.fontSizePx,
    }),
    align: () => ({ textAlign: format.textAlign ?? "center" }),
    wordBreak: () => ({ wordBreak: format.wordBreak ?? defaults.wordBreak }),
    direction: () => ({
      renderDirection: format.renderDirection ?? "horizontal",
    }),
    emphasis: () => ({
      bold: format.bold ?? false,
      italic: format.italic ?? false,
    }),
    lineSpacing: () => ({
      lineHeight: format.lineHeight ?? defaults.lineHeight,
    }),
    letterSpacing: () => ({
      letterSpacing: format.letterSpacing ?? defaults.letterSpacing,
    }),
    fontWidth: () => ({
      fontWidthScale: format.fontWidthScale ?? defaults.fontWidthScale,
    }),
    color: () => ({ textColor: format.textColor ?? defaults.textColor }),
    outline: () => ({
      outlineEnabled:
        format.outlineWidthPx === undefined
          ? (format.outlineWidthScale ?? 0) > 0
          : format.outlineWidthPx > 0,
      outlineColor: format.outlineColor ?? defaults.outlineColor,
      outlineWidthPx: format.outlineWidthPx,
      outlineWidthScale: format.outlineWidthScale ?? 0,
    }),
    transform: () => ({
      rotationDeg: format.rotationDeg ?? 0,
      textOpacity: format.textOpacity ?? defaults.textOpacity,
    }),
  };
  return builders[groupId]();
}

export function updateStylePresetFromEditor(
  preset: BlockStylePreset,
  defaults: BlockFormatDefaults,
  patch: EditorPatch,
): BlockStylePreset {
  const touchedGroups = resolveTouchedGroups(patch);
  if (touchedGroups.length === 0) return preset;
  const nextValues = {
    ...resolveStylePresetEditorValues(defaults, preset),
    ...patch,
  };
  let format = { ...preset.format };
  for (const groupId of touchedGroups) {
    format = replaceGroupFormat(format, groupId, nextValues);
  }
  return {
    ...preset,
    groupIds: orderGroupIds([...preset.groupIds, ...touchedGroups]),
    format,
  };
}

export function setStylePresetGroupEnabled(
  preset: BlockStylePreset,
  defaults: BlockFormatDefaults,
  groupId: BlockFormatGroupId,
  enabled: boolean,
): BlockStylePreset {
  if (enabled === preset.groupIds.includes(groupId)) return preset;
  if (!enabled) {
    if (preset.groupIds.length <= 1) return preset;
    return {
      ...preset,
      groupIds: preset.groupIds.filter((candidate) => candidate !== groupId),
      format: clearGroupFormat(preset.format, groupId),
    };
  }
  const values = resolveStylePresetEditorValues(defaults, preset);
  return {
    ...preset,
    groupIds: orderGroupIds([...preset.groupIds, groupId]),
    format: replaceGroupFormat(preset.format, groupId, values),
  };
}

function resolveTouchedGroups(patch: EditorPatch): BlockFormatGroupId[] {
  const keys = new Set(Object.keys(patch) as EditorField[]);
  return ALL_BLOCK_FORMAT_GROUP_IDS.filter((groupId) =>
    EDITOR_FIELDS_BY_GROUP[groupId].some((field) => keys.has(field)),
  );
}

function replaceGroupFormat(
  current: PresetFormat,
  groupId: BlockFormatGroupId,
  values: StylePresetEditorValues,
): PresetFormat {
  return compactFormat({
    ...clearGroupFormat(current, groupId),
    ...buildGroupFormat(groupId, values),
  });
}

function clearGroupFormat(
  current: PresetFormat,
  groupId: BlockFormatGroupId,
): PresetFormat {
  const next = { ...current };
  for (const field of PRESET_FIELDS_BY_GROUP[groupId]) {
    delete next[field];
  }
  return next;
}

function buildGroupFormat(
  groupId: BlockFormatGroupId,
  values: StylePresetEditorValues,
): PresetFormat {
  const builders: Record<BlockFormatGroupId, () => PresetFormat> = {
    font: () => ({ fontFamily: values.fontFamily }),
    size: () => ({
      autoFitText: values.autoFitText,
      fontSizePx: values.fontSizePx,
    }),
    align: () => ({ textAlign: values.textAlign }),
    wordBreak: () => ({ wordBreak: values.wordBreak }),
    direction: () => ({
      renderDirection:
        values.renderDirection === "auto"
          ? ("horizontal" as TranslationBlock["renderDirection"])
          : values.renderDirection,
    }),
    emphasis: () => ({ bold: values.bold, italic: values.italic }),
    lineSpacing: () => ({ lineHeight: values.lineHeight }),
    letterSpacing: () => ({ letterSpacing: values.letterSpacing }),
    fontWidth: () => ({ fontWidthScale: values.fontWidthScale }),
    color: () => ({ textColor: values.textColor }),
    outline: () =>
      values.outlineEnabled
        ? values.outlineWidthPx === undefined
          ? {
              outlineColor: values.outlineColor,
              outlineWidthScale: values.outlineWidthScale,
            }
          : {
              outlineColor: values.outlineColor,
              outlineWidthPx: values.outlineWidthPx,
            }
        : { outlineWidthPx: 0 },
    transform: () => ({
      rotationDeg: values.rotationDeg,
      textOpacity: values.textOpacity,
    }),
  };
  return builders[groupId]();
}

function compactFormat(format: PresetFormat): PresetFormat {
  return Object.fromEntries(
    Object.entries(format).filter(([, value]) => value !== undefined),
  ) as PresetFormat;
}

function orderGroupIds(
  groupIds: readonly BlockFormatGroupId[],
): BlockFormatGroupId[] {
  const selected = new Set(groupIds);
  return ALL_BLOCK_FORMAT_GROUP_IDS.filter((groupId) => selected.has(groupId));
}
