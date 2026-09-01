import {
  ALL_BLOCK_FORMAT_GROUP_IDS,
  type BlockFormatDefaults,
  type BlockFormatGroupId,
} from "../../../../shared/blockFormat";
import type { BlockStylePreset } from "../../../../shared/blockStylePresets";
import type {
  TextEffect,
  TextGlow,
  TranslationBlock,
} from "../../../../shared/textTypes";
import {
  DEFAULT_TEXT_EFFECT,
  cloneTextEffect,
} from "../../../../shared/textEffect";
import { DEFAULT_TEXT_GLOW, cloneTextGlow } from "../../../../shared/textGlow";

export type StylePresetEditorValues = BlockFormatDefaults & {
  rotationDeg: number;
  textEffect: TextEffect;
  textGlow: TextGlow;
  underline: boolean;
  strikethrough: boolean;
  emphasisMark: boolean;
  textBackgroundEnabled: boolean;
  textBackgroundColor: string;
  outerOutlineColor: string;
  outerOutlineWidthPx: number;
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
  emphasis: ["bold", "italic", "underline", "strikethrough", "emphasisMark"],
  lineSpacing: ["lineHeight"],
  letterSpacing: ["letterSpacing"],
  fontWidth: ["fontWidthScale"],
  color: ["textColor", "textBackgroundEnabled", "textBackgroundColor"],
  outline: [
    "outlineEnabled",
    "outlineColor",
    "outlineWidthPx",
    "outlineWidthScale",
    "outerOutlineColor",
    "outerOutlineWidthPx",
  ],
  effect: ["textEffect", "textGlow"],
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
  emphasis: ["bold", "italic", "underline", "strikethrough", "emphasisMark"],
  lineSpacing: ["lineHeight"],
  letterSpacing: ["letterSpacing"],
  fontWidth: ["fontWidthScale"],
  color: ["textColor", "textBackgroundEnabled", "textBackgroundColor"],
  outline: [
    "outlineColor",
    "outlineWidthPx",
    "outlineWidthScale",
    "outerOutlineColor",
    "outerOutlineWidthPx",
  ],
  effect: ["textEffect", "textGlow"],
  transform: ["rotationDeg", "textOpacity"],
};

export function resolveStylePresetEditorValues(
  defaults: BlockFormatDefaults,
  preset: BlockStylePreset,
): StylePresetEditorValues {
  const values: StylePresetEditorValues = {
    ...defaults,
    rotationDeg: 0,
    textEffect: { ...DEFAULT_TEXT_EFFECT },
    textGlow: { ...DEFAULT_TEXT_GLOW },
    underline: false,
    strikethrough: false,
    emphasisMark: false,
    textBackgroundEnabled: false,
    textBackgroundColor: "#ffffff",
    outerOutlineColor: "#111111",
    outerOutlineWidthPx: 0,
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
      underline: format.underline ?? false,
      strikethrough: format.strikethrough ?? false,
      emphasisMark: format.emphasisMark ?? false,
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
    color: () => ({
      textColor: format.textColor ?? defaults.textColor,
      textBackgroundEnabled: format.textBackgroundEnabled ?? false,
      textBackgroundColor: format.textBackgroundColor ?? "#ffffff",
    }),
    outline: () => ({
      outlineEnabled:
        format.outlineWidthPx === undefined
          ? (format.outlineWidthScale ?? 0) > 0
          : format.outlineWidthPx > 0,
      outlineColor: format.outlineColor ?? defaults.outlineColor,
      outlineWidthPx: format.outlineWidthPx,
      outlineWidthScale: format.outlineWidthScale ?? 0,
      outerOutlineColor: format.outerOutlineColor ?? "#111111",
      outerOutlineWidthPx: format.outerOutlineWidthPx ?? 0,
    }),
    effect: () => ({
      textEffect: format.textEffect
        ? cloneTextEffect(format.textEffect)
        : { ...DEFAULT_TEXT_EFFECT },
      textGlow: format.textGlow
        ? cloneTextGlow(format.textGlow)
        : { ...DEFAULT_TEXT_GLOW },
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
  const editedFields = new Set(Object.keys(patch) as EditorField[]);
  let format = { ...preset.format };
  for (const groupId of touchedGroups) {
    format = replaceGroupFormat(format, groupId, nextValues, editedFields);
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
  editedFields: ReadonlySet<EditorField> = new Set(),
): PresetFormat {
  const groupFormat = buildGroupFormat(groupId, values);
  removeUntouchedOptionalFields(groupFormat, current, editedFields);
  return compactFormat({
    ...clearGroupFormat(current, groupId),
    ...groupFormat,
  });
}

const OPTIONAL_NEW_PRESET_FIELDS = [
  "underline",
  "strikethrough",
  "emphasisMark",
  "textBackgroundEnabled",
  "textBackgroundColor",
  "outerOutlineColor",
  "outerOutlineWidthPx",
  "textGlow",
] as const satisfies readonly (EditorField & PresetFormatField)[];

function removeUntouchedOptionalFields(
  groupFormat: PresetFormat,
  current: PresetFormat,
  editedFields: ReadonlySet<EditorField>,
): void {
  for (const field of OPTIONAL_NEW_PRESET_FIELDS) {
    if (!(field in current) && !editedFields.has(field)) {
      delete groupFormat[field];
    }
  }
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
    emphasis: () => ({
      bold: values.bold,
      italic: values.italic,
      underline: values.underline,
      strikethrough: values.strikethrough,
      emphasisMark: values.emphasisMark,
    }),
    lineSpacing: () => ({ lineHeight: values.lineHeight }),
    letterSpacing: () => ({ letterSpacing: values.letterSpacing }),
    fontWidth: () => ({ fontWidthScale: values.fontWidthScale }),
    color: () => ({
      textColor: values.textColor,
      textBackgroundEnabled: values.textBackgroundEnabled,
      textBackgroundColor: values.textBackgroundColor,
    }),
    outline: () =>
      values.outlineEnabled
        ? values.outlineWidthPx === undefined
          ? {
              outlineColor: values.outlineColor,
              outlineWidthScale: values.outlineWidthScale,
              outerOutlineColor: values.outerOutlineColor,
              outerOutlineWidthPx: values.outerOutlineWidthPx,
            }
          : {
              outlineColor: values.outlineColor,
              outlineWidthPx: values.outlineWidthPx,
              outerOutlineColor: values.outerOutlineColor,
              outerOutlineWidthPx: values.outerOutlineWidthPx,
            }
        : {
            outlineWidthPx: 0,
            outerOutlineColor: values.outerOutlineColor,
            outerOutlineWidthPx: values.outerOutlineWidthPx,
          },
    effect: () => ({
      textEffect: cloneTextEffect(values.textEffect),
      textGlow: cloneTextGlow(values.textGlow),
    }),
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
