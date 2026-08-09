import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  ALL_BLOCK_FORMAT_GROUP_IDS,
  type BlockFormatGroupId,
} from "../../../../../shared/blockFormat";
import {
  MAX_BLOCK_STYLE_PRESET_NAME_LENGTH,
  type BlockStylePreset,
} from "../../../../../shared/blockStylePresets";
import type { GatherTextDirectFormatValues } from "../../../lib/gatherTextDirectFormatModel";
import { BlockFormatPreviewStage } from "../../gatherText/GatherTextDirectFormatPreview";

export type PresetFontDetail = { cssFamily: string; label: string };

export function PresetDefinitionPanel({
  fontDetails,
  preset,
  onPatch,
}: {
  fontDetails: ReadonlyMap<string, PresetFontDetail>;
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
      <label className="style-preset-pin-toggle">
        <input
          type="checkbox"
          checked={preset.pinned}
          onChange={(event) => onPatch({ pinned: event.target.checked })}
        />
        <span>{t("stylePresets.pinQuick")}</span>
      </label>
    </section>
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
    <label className="style-preset-property" data-enabled={enabled}>
      <input
        type="checkbox"
        checked={enabled}
        onChange={(event) =>
          onPatch({
            groupIds: updateSelectedGroups(
              preset.groupIds,
              groupId,
              event.target.checked,
            ),
          })
        }
      />
      <span className="style-preset-property-label">
        {t(`formatBatch.groups.${groupId}`)}
      </span>
      <PresetFormatValue
        fontDetails={fontDetails}
        groupId={groupId}
        preset={preset}
      />
    </label>
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

const PRESET_PREVIEW_DEFAULTS: GatherTextDirectFormatValues = {
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
  outlineWidthScale: 0,
  rotationDeg: 0,
};

function createPresetPreviewValues(
  preset: BlockStylePreset,
): GatherTextDirectFormatValues {
  return { ...PRESET_PREVIEW_DEFAULTS, ...preset.format };
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

function resolveOutlineValue({ format }: FormatValueContext): string {
  if ((format.outlineWidthScale ?? 0) <= 0) return "—";
  const color = (format.outlineColor ?? "#FFFFFF").toUpperCase();
  return `${color} · ${(format.outlineWidthScale ?? 0).toFixed(1)}`;
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
