import React from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_BLOCK_FONT_ID } from "../../../../shared/blockFontCatalog";
import type {
  BlockFormatDefaults,
  BlockFormatDirectionDefault,
} from "../../../../shared/settingsTypes";
import { useFonts } from "../../fonts/useFonts";
import type { GatherTextDirectFormatValues } from "../../lib/gatherTextDirectFormatModel";
import { FontSizeNumberInput } from "../FontSizeNumberInput";
import { BlockFormatPreview } from "../gatherText/GatherTextDirectFormatPreview";
import {
  DirectControlCaption,
  DirectSectionHeading,
} from "../gatherText/GatherTextDirectFormatPrimitives";
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BoldIcon,
  ItalicIcon,
} from "../ui/icons";
import {
  FormatDefaultsColorSection,
  FormatDefaultsFineTuningSection,
} from "./FormatDefaultsDetailSections";

export type FormatDefaultsPanelProps = {
  value: BlockFormatDefaults;
  onChange: (patch: Partial<BlockFormatDefaults>) => void;
};

type SectionProps = FormatDefaultsPanelProps;

const DEFAULT_FONT_VALUE = "__format_defaults_font__";

const DIRECTION_OPTIONS: {
  id: BlockFormatDirectionDefault;
  labelKey: string;
}[] = [
  { id: "auto", labelKey: "settings.format.direction.auto" },
  { id: "horizontal", labelKey: "settings.format.direction.horizontal" },
  { id: "vertical", labelKey: "settings.format.direction.vertical" },
];

export function FormatDefaultsPanel({
  value,
  onChange,
}: FormatDefaultsPanelProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const [exampleText, setExampleText] = React.useState(() =>
    t("gatherText.previewTextDefault"),
  );
  const previewValues = React.useMemo(
    () => createPreviewValues(value),
    [value],
  );

  return (
    <div className="format-defaults format-defaults-editor">
      <BlockFormatPreview
        exampleText={exampleText}
        values={previewValues}
        title={t("gatherText.previewTitle")}
        description={t("settings.format.description")}
        exampleLabel={t("gatherText.previewTextLabel")}
        placeholder={t("gatherText.previewTextPlaceholder")}
        autoFitLabel={t("gatherText.autoFitBadge")}
        onExampleTextChange={setExampleText}
      />
      <div className="format-defaults-editor-controls">
        <TypographySection value={value} onChange={onChange} />
        <FormatDefaultsColorSection value={value} onChange={onChange} />
        <FormatDefaultsFineTuningSection value={value} onChange={onChange} />
      </div>
    </div>
  );
}

function TypographySection({
  value,
  onChange,
}: SectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="gather-direct-editor-section">
      <DirectSectionHeading title={t("gatherText.typographySection")} />
      <div className="gather-direct-editor-type-row">
        <DefaultFontPicker value={value.fontFamily} onChange={onChange} />
        <DefaultFontSizeControl value={value} onChange={onChange} />
        <DefaultAutoFitControl value={value.autoFitText} onChange={onChange} />
      </div>
      <DefaultStyleToolbar value={value} onChange={onChange} />
    </section>
  );
}

function DefaultFontPicker({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: FormatDefaultsPanelProps["onChange"];
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const { options } = useFonts();
  const defaultOption = options.find(
    (option) => option.id === DEFAULT_BLOCK_FONT_ID,
  );
  return (
    <label className="gather-direct-font-picker">
      <DirectControlCaption
        label={t("formatBatch.groups.font")}
        mixed={false}
        touched={false}
      />
      <select
        aria-label={t("formatBatch.groups.font")}
        value={value ?? DEFAULT_FONT_VALUE}
        onChange={(event) =>
          onChange({
            fontFamily:
              event.target.value === DEFAULT_FONT_VALUE
                ? undefined
                : event.target.value,
          })
        }
      >
        <option value={DEFAULT_FONT_VALUE}>
          {defaultOption?.label ?? t("gatherText.defaultFont")}
        </option>
        {options
          .filter((option) => option.id !== DEFAULT_BLOCK_FONT_ID)
          .map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
      </select>
    </label>
  );
}

function DefaultFontSizeControl({
  value,
  onChange,
}: SectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const updateSize = (next: number): void =>
    onChange({ fontSizePx: clampFontSize(next), autoFitText: false });
  return (
    <div className="gather-direct-size-control">
      <DirectControlCaption
        label={t("format.fontSize")}
        mixed={false}
        touched={false}
      />
      <div className="gather-direct-size-stepper">
        <button
          type="button"
          aria-label={t("format.fontSizeDecrease")}
          disabled={value.fontSizePx <= 10}
          onClick={() => updateSize(value.fontSizePx - 1)}
        >
          −
        </button>
        <FontSizeNumberInput
          className="gather-direct-size-input"
          ariaLabel={t("format.fontSize")}
          value={value.fontSizePx}
          onValueChange={updateSize}
        />
        <button
          type="button"
          aria-label={t("format.fontSizeIncrease")}
          disabled={value.fontSizePx >= 160}
          onClick={() => updateSize(value.fontSizePx + 1)}
        >
          +
        </button>
      </div>
    </div>
  );
}

function DefaultAutoFitControl({
  value,
  onChange,
}: {
  value: boolean;
  onChange: FormatDefaultsPanelProps["onChange"];
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="gather-direct-auto-control">
      <DirectControlCaption
        label={t("gatherText.autoFitLabel")}
        mixed={false}
        touched={false}
      />
      <button
        type="button"
        className="gather-direct-pill-toggle"
        aria-pressed={value}
        onClick={() => onChange({ autoFitText: !value })}
      >
        <span aria-hidden="true" />
        {value ? t("gatherText.toggleOn") : t("gatherText.toggleOff")}
      </button>
    </div>
  );
}

function DefaultStyleToolbar({
  value,
  onChange,
}: SectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const alignmentTools = [
    ["left", t("settings.format.alignment.left"), <AlignLeftIcon size={17} />],
    [
      "center",
      t("settings.format.alignment.center"),
      <AlignCenterIcon size={17} />,
    ],
    [
      "right",
      t("settings.format.alignment.right"),
      <AlignRightIcon size={17} />,
    ],
  ] as const;
  return (
    <div className="gather-direct-style-toolbar">
      <div className="gather-direct-toolbar-group">
        <DefaultToolButton
          label={t("settings.format.alignment.bold")}
          pressed={value.bold}
          onClick={() => onChange({ bold: !value.bold })}
        >
          <BoldIcon size={17} />
        </DefaultToolButton>
        <DefaultToolButton
          label={t("settings.format.alignment.italic")}
          pressed={value.italic}
          onClick={() => onChange({ italic: !value.italic })}
        >
          <ItalicIcon size={17} />
        </DefaultToolButton>
      </div>
      <span className="gather-direct-toolbar-divider" aria-hidden="true" />
      <div className="gather-direct-toolbar-group">
        {alignmentTools.map(([alignment, label, icon]) => (
          <DefaultToolButton
            key={alignment}
            label={label}
            pressed={value.textAlign === alignment}
            onClick={() => onChange({ textAlign: alignment })}
          >
            {icon}
          </DefaultToolButton>
        ))}
      </div>
      <span className="gather-direct-toolbar-divider" aria-hidden="true" />
      <div className="gather-direct-toolbar-group direction">
        {DIRECTION_OPTIONS.map((option) => (
          <DefaultToolButton
            key={option.id}
            label={t(option.labelKey)}
            pressed={value.renderDirection === option.id}
            onClick={() => onChange({ renderDirection: option.id })}
          >
            <span>{t(option.labelKey)}</span>
          </DefaultToolButton>
        ))}
      </div>
    </div>
  );
}

function DefaultToolButton({
  children,
  label,
  pressed,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  pressed: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="gather-direct-tool-button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function createPreviewValues(
  value: BlockFormatDefaults,
): GatherTextDirectFormatValues {
  return {
    fontFamily: value.fontFamily,
    fontSizePx: value.fontSizePx,
    autoFitText: value.autoFitText,
    textAlign: value.textAlign,
    renderDirection:
      value.renderDirection === "vertical" ? "vertical" : "horizontal",
    bold: value.bold,
    italic: value.italic,
    lineHeight: value.lineHeight,
    letterSpacing: value.letterSpacing,
    fontWidthScale: value.fontWidthScale,
    textColor: value.textColor,
    textOpacity: value.textOpacity,
    outlineColor: value.outlineColor,
    outlineWidthScale: value.outlineEnabled ? value.outlineWidthScale : 0,
    rotationDeg: 0,
  };
}

function clampFontSize(value: number): number {
  if (!Number.isFinite(value)) {
    return 24;
  }
  return Math.max(10, Math.min(160, Math.round(value)));
}
