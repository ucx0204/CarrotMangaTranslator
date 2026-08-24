import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  ALL_BLOCK_FORMAT_GROUP_IDS,
  type BlockFormatGroupId,
} from "../../../../../shared/blockFormat";
import {
  MAX_BLOCK_STYLE_PRESET_NAME_LENGTH,
  MAX_BLOCK_STYLE_PRESET_SHORTCUT_SLOT,
  type BlockStylePreset,
  type BlockStylePresetGroup,
} from "../../../../../shared/blockStylePresets";
import { resolveEffectiveTextOutlineWidthPx } from "../../../../../shared/textOutline";
import { resolveTextEffect } from "../../../../../shared/textEffect";
import {
  BlockFormatPreviewStage,
  type BlockFormatPreviewValues,
} from "../../blockFormat/BlockFormatPreview";
import { CheckboxField } from "../../ui/CheckboxField";
import { Select } from "../../ui/Select";
import { toast } from "../../../lib/toastStore";

export type PresetFontDetail = { cssFamily: string; label: string };

export function PresetDefinitionPanel({
  fontDetails,
  groups,
  preset,
  onPatch,
}: {
  fontDetails: ReadonlyMap<string, PresetFontDetail>;
  groups: BlockStylePresetGroup[];
  preset: BlockStylePreset;
  onPatch: (patch: Partial<BlockStylePreset>) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="style-preset-definition">
      <div className="style-preset-definition-heading">
        <input
          className="style-preset-definition-name"
          aria-label={t("stylePresets.name")}
          maxLength={MAX_BLOCK_STYLE_PRESET_NAME_LENGTH}
          value={preset.name}
          onChange={(event) => onPatch({ name: event.target.value })}
          onBlur={(event) => {
            const name = event.target.value.trim();
            onPatch({ name: name || t("stylePresets.untitled") });
          }}
        />
        <Select
          ariaLabel={t("stylePresets.group")}
          value={preset.groupId ?? "__ungrouped__"}
          options={[
            {
              value: "__ungrouped__",
              label: t("stylePresets.ungrouped"),
            },
            ...groups.map((group) => ({
              value: group.id,
              label: group.name,
            })),
          ]}
          onValueChange={(groupId) =>
            onPatch({
              groupId: groupId === "__ungrouped__" ? undefined : groupId,
            })
          }
        />
      </div>
      <PresetAppearancePreview preset={preset} />
      <div className="style-preset-property-list">
        {ALL_BLOCK_FORMAT_GROUP_IDS.map((groupId) => (
          <PresetProperty
            fontDetails={fontDetails}
            groupId={groupId}
            key={groupId}
            preset={preset}
            onPatch={onPatch}
          />
        ))}
      </div>
      <CheckboxField
        className="style-preset-pin-toggle"
        label={t("stylePresets.pinQuick")}
        checked={preset.pinned}
        onCheckedChange={(checked) => onPatch({ pinned: checked })}
      />
      <PresetShortcutSlotField preset={preset} onPatch={onPatch} />
    </section>
  );
}

function PresetShortcutSlotField({
  preset,
  onPatch,
}: {
  preset: BlockStylePreset;
  onPatch: (patch: Partial<BlockStylePreset>) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const slots = Array.from(
    { length: MAX_BLOCK_STYLE_PRESET_SHORTCUT_SLOT },
    (_, index) => index + 1,
  );
  return (
    <div className="settings-field style-preset-shortcut-slot">
      <span>{t("stylePresets.shortcutSlot")}</span>
      <Select
        ariaLabel={t("stylePresets.shortcutSlot")}
        value={preset.shortcutSlot ? String(preset.shortcutSlot) : ""}
        options={[
          { value: "", label: t("stylePresets.shortcutSlotNone") },
          ...slots.map((slot) => ({
            value: String(slot),
            label: t("stylePresets.shortcutSlotValue", { slot }),
          })),
        ]}
        onValueChange={(value) =>
          onPatch({
            shortcutSlot: value ? Number(value) : undefined,
          })
        }
      />
    </div>
  );
}

function PresetProperty({
  fontDetails,
  groupId,
  preset,
  onPatch,
}: {
  fontDetails: ReadonlyMap<string, PresetFontDetail>;
  groupId: BlockFormatGroupId;
  preset: BlockStylePreset;
  onPatch: (patch: Partial<BlockStylePreset>) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const enabled = preset.groupIds.includes(groupId);
  return (
    <CheckboxField
      variant="bare"
      className="style-preset-property"
      dataSelected={enabled}
      label={
        <span className="style-preset-property-label">
          {t(`formatBatch.groups.${groupId}`)}
        </span>
      }
      checked={enabled}
      onCheckedChange={(checked) => {
        if (!checked && preset.groupIds.length === 1) {
          toast.warn(t("stylePresets.minimumGroupRequired"));
          return;
        }
        onPatch({
          groupIds: updateSelectedGroups(preset.groupIds, groupId, checked),
        });
      }}
    >
      <PresetFormatValue
        fontDetails={fontDetails}
        groupId={groupId}
        preset={preset}
      />
    </CheckboxField>
  );
}

function PresetAppearancePreview({
  preset,
}: {
  preset: BlockStylePreset;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <BlockFormatPreviewStage
      autoFitLabel={t("gatherText.autoFitBadge")}
      compact
      previewText="가나다 ABC 123"
      values={createPresetPreviewValues(preset)}
    />
  );
}

const PRESET_PREVIEW_DEFAULTS: BlockFormatPreviewValues = {
  fontFamily: undefined,
  fontSizePx: 24,
  autoFitText: true,
  textAlign: "center",
  renderDirection: "horizontal",
  wordBreak: "normal",
  bold: false,
  italic: false,
  lineHeight: 1.18,
  letterSpacing: 0,
  fontWidthScale: 1,
  textColor: "#111111",
  textOpacity: 1,
  outlineColor: undefined,
  outlineWidthPx: 0,
  rotationDeg: 0,
};

function createPresetPreviewValues(
  preset: BlockStylePreset,
): BlockFormatPreviewValues {
  const fontSizePx =
    preset.format.fontSizePx ?? PRESET_PREVIEW_DEFAULTS.fontSizePx;
  return {
    ...PRESET_PREVIEW_DEFAULTS,
    ...preset.format,
    fontSizePx,
    outlineWidthPx: resolveEffectiveTextOutlineWidthPx(
      preset.format,
      fontSizePx,
    ),
  };
}

type FormatValueContext = {
  fontDetails: ReadonlyMap<string, PresetFontDetail>;
  format: BlockStylePreset["format"];
  t: TFunction;
};

const FORMAT_VALUE_RESOLVERS: Record<
  BlockFormatGroupId,
  (context: FormatValueContext) => string
> = {
  font: ({ fontDetails, format, t }) =>
    format.fontFamily
      ? (fontDetails.get(format.fontFamily)?.label ?? format.fontFamily)
      : t("gatherText.defaultFont"),
  size: ({ format, t }) =>
    format.autoFitText ? t("format.auto") : `${format.fontSizePx ?? 24}px`,
  align: ({ format, t }) => t(`format.align.${format.textAlign ?? "center"}`),
  wordBreak: ({ format, t }) =>
    t(`format.wordBreak.options.${format.wordBreak ?? "normal"}`),
  direction: ({ format, t }) =>
    t(`format.direction.${format.renderDirection ?? "horizontal"}`),
  emphasis: resolveEmphasisValue,
  lineSpacing: ({ format }) => (format.lineHeight ?? 1.18).toFixed(2),
  letterSpacing: ({ format }) => (format.letterSpacing ?? 0).toFixed(2),
  fontWidth: ({ format }) =>
    `${Math.round((format.fontWidthScale ?? 1) * 100)}%`,
  color: ({ format }) => (format.textColor ?? "#111111").toUpperCase(),
  outline: resolveOutlineValue,
  effect: resolveEffectValue,
  transform: ({ format }) =>
    `${format.rotationDeg ?? 0}° · ${Math.round((format.textOpacity ?? 1) * 100)}%`,
};

function resolveEmphasisValue({ format, t }: FormatValueContext): string {
  const styles = [
    format.bold ? t("format.bold") : "",
    format.italic ? t("format.italicShort") : "",
  ].filter(Boolean);
  return styles.join(" · ") || "—";
}

function resolveEffectValue({ format }: FormatValueContext): string {
  const effect = resolveTextEffect(format.textEffect);
  if (!effect.enabled) return "—";
  return `${effect.color.toUpperCase()} · ${effect.offsetXpx}/${effect.offsetYpx}px · ${effect.blurPx}px · ${Math.round(effect.opacity * 100)}%`;
}

function resolveOutlineValue({ format }: FormatValueContext): string {
  const outlineWidthPx = resolveEffectiveTextOutlineWidthPx(
    format,
    format.fontSizePx ?? PRESET_PREVIEW_DEFAULTS.fontSizePx,
  );
  if (outlineWidthPx <= 0) return "—";
  const color = (format.outlineColor ?? "#FFFFFF").toUpperCase();
  return `${color} · ${outlineWidthPx.toFixed(1)}px`;
}

function PresetFormatValue({
  fontDetails,
  groupId,
  preset,
}: {
  fontDetails: ReadonlyMap<string, PresetFontDetail>;
  groupId: BlockFormatGroupId;
  preset: BlockStylePreset;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const text = FORMAT_VALUE_RESOLVERS[groupId]({
    fontDetails,
    format: preset.format,
    t,
  });
  const swatch = resolveSwatch(preset, groupId);
  return (
    <span className="style-preset-property-value">
      {swatch ? (
        <i style={{ backgroundColor: swatch }} aria-hidden="true" />
      ) : null}
      <span>{text}</span>
    </span>
  );
}

function resolveSwatch(
  preset: BlockStylePreset,
  groupId: BlockFormatGroupId,
): string | undefined {
  if (groupId === "color") return preset.format.textColor;
  if (groupId === "outline") return preset.format.outlineColor;
  if (groupId === "effect") return preset.format.textEffect?.color;
  return undefined;
}

function updateSelectedGroups(
  current: BlockFormatGroupId[],
  groupId: BlockFormatGroupId,
  checked: boolean,
): BlockFormatGroupId[] {
  return checked
    ? ALL_BLOCK_FORMAT_GROUP_IDS.filter(
        (candidate) => candidate === groupId || current.includes(candidate),
      )
    : current.filter((candidate) => candidate !== groupId);
}
