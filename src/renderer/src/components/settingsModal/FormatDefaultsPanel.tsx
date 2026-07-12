import React from "react";
import { useTranslation } from "react-i18next";
import type {
  BlockFormatDefaults,
  BlockFormatDirectionDefault,
} from "../../../../shared/settingsTypes";
import {
  MAX_FONT_WIDTH_SCALE,
  MIN_FONT_WIDTH_SCALE,
} from "../../../../shared/geometry";
import { ColorField } from "../ColorField";
import { FontSelect } from "../FontSelect";
import { FieldSlider, IconButton, RangeInput } from "../ui";
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BoldIcon,
  ItalicIcon,
} from "../ui/icons";

export type FormatDefaultsPanelProps = {
  value: BlockFormatDefaults;
  onChange: (patch: Partial<BlockFormatDefaults>) => void;
};

type SectionProps = FormatDefaultsPanelProps;

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
  return (
    <div className="format-defaults">
      <p className="muted-line modal-note">
        {t("settings.format.description")}
      </p>
      <DirectionAlignSection value={value} onChange={onChange} />
      <FontSizeSection value={value} onChange={onChange} />
      <SpacingSection value={value} onChange={onChange} />
      <ColorSection value={value} onChange={onChange} />
    </div>
  );
}

function DirectionAlignSection({
  value,
  onChange,
}: SectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="editor-group">
      <div className="editor-group-head">
        <h3>{t("settings.format.alignment.title")}</h3>
      </div>
      <div className="format-toolbar">
        <div className="block-style-group">
          <IconButton
            label={t("settings.format.alignment.bold")}
            title={t("settings.format.alignment.bold")}
            aria-pressed={value.bold}
            onClick={() => onChange({ bold: !value.bold })}
          >
            <BoldIcon size={18} />
          </IconButton>
          <IconButton
            label={t("settings.format.alignment.italic")}
            title={t("settings.format.alignment.italic")}
            aria-pressed={value.italic}
            onClick={() => onChange({ italic: !value.italic })}
          >
            <ItalicIcon size={18} />
          </IconButton>
        </div>
        <div className="block-style-group">
          {(["left", "center", "right"] as const).map((align) => (
            <IconButton
              key={align}
              label={t(ALIGN_LABEL_KEYS[align])}
              title={t(ALIGN_LABEL_KEYS[align])}
              aria-pressed={value.textAlign === align}
              onClick={() => onChange({ textAlign: align })}
            >
              <AlignIcon align={align} />
            </IconButton>
          ))}
        </div>
        <div
          className="dir-toggle"
          role="group"
          aria-label={t("settings.format.direction.ariaLabel")}
        >
          {DIRECTION_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={value.renderDirection === option.id}
              onClick={() => onChange({ renderDirection: option.id })}
            >
              {t(option.labelKey)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function FontSizeSection({ value, onChange }: SectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const setSize = (raw: number): void =>
    onChange({ fontSizePx: clampFontSize(raw) });
  return (
    <div className="editor-group">
      <div className="editor-group-head">
        <h3>{t("settings.format.font.title")}</h3>
      </div>
      <div className="font-field">
        <FontSelect
          value={value.fontFamily}
          onChange={(fontFamily) => onChange({ fontFamily })}
        />
      </div>
      <div className="font-size-row">
        <span className="font-size-label">
          {t("settings.format.font.size")}
        </span>
        <RangeInput
          aria-label={t("settings.format.font.sizeAria")}
          min={10}
          max={160}
          step={1}
          value={value.fontSizePx}
          disabled={value.autoFitText}
          onChange={(event) => setSize(Number(event.target.value))}
        />
        <input
          className="font-size-number"
          type="number"
          aria-label={t("settings.format.font.sizeValueAria")}
          min={10}
          max={160}
          step={1}
          value={value.fontSizePx}
          disabled={value.autoFitText}
          onChange={(event) => setSize(Number(event.target.value))}
        />
        <label
          className="inline-toggle"
          title={t("settings.format.font.autoFitTitle")}
        >
          <input
            type="checkbox"
            checked={value.autoFitText}
            onChange={(event) =>
              onChange({ autoFitText: event.target.checked })
            }
          />
          {t("settings.format.font.auto")}
        </label>
      </div>
    </div>
  );
}

function SpacingSection({ value, onChange }: SectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="editor-group">
      <div className="editor-group-head">
        <h3>{t("settings.format.spacing.title")}</h3>
      </div>
      <FieldSlider
        label={t("settings.format.spacing.lineHeight")}
        valueLabel={value.lineHeight.toFixed(2)}
        min={0.8}
        max={3}
        step={0.05}
        value={value.lineHeight}
        onChange={(event) =>
          onChange({ lineHeight: round2(Number(event.target.value)) })
        }
      />
      <FieldSlider
        label={t("settings.format.spacing.letterSpacing")}
        valueLabel={value.letterSpacing.toFixed(2)}
        min={-0.1}
        max={0.5}
        step={0.01}
        value={value.letterSpacing}
        onChange={(event) =>
          onChange({ letterSpacing: round2(Number(event.target.value)) })
        }
      />
      <FieldSlider
        label={t("settings.format.spacing.fontWidth")}
        valueLabel={`${Math.round(value.fontWidthScale * 100)}%`}
        min={MIN_FONT_WIDTH_SCALE}
        max={MAX_FONT_WIDTH_SCALE}
        step={0.01}
        value={value.fontWidthScale}
        onChange={(event) =>
          onChange({ fontWidthScale: round2(Number(event.target.value)) })
        }
      />
    </div>
  );
}

function ColorSection({ value, onChange }: SectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="editor-group">
      <div className="editor-group-head">
        <h3>{t("settings.format.color.title")}</h3>
      </div>
      <div
        className="color-row"
        aria-label={t("settings.format.color.ariaLabel")}
      >
        <ColorField
          label={t("settings.format.color.text")}
          value={value.textColor}
          disabled={false}
          onChange={(textColor) => onChange({ textColor })}
        />
        <ColorField
          label={t("settings.format.color.outline")}
          value={value.outlineColor}
          disabled={!value.outlineEnabled}
          onChange={(outlineColor) => onChange({ outlineColor })}
        />
      </div>
      <label
        className="inline-toggle"
        title={t("settings.format.color.outlineEnabledTitle")}
      >
        <input
          type="checkbox"
          checked={value.outlineEnabled}
          onChange={(event) =>
            onChange({ outlineEnabled: event.target.checked })
          }
        />
        {t("settings.format.color.outlineEnabled")}
      </label>
      <FieldSlider
        label={t("settings.format.color.outlineWidth")}
        valueLabel={`${Math.round(value.outlineWidthScale * 100)}%`}
        min={0}
        max={2.5}
        step={0.1}
        value={value.outlineWidthScale}
        disabled={!value.outlineEnabled}
        onChange={(event) =>
          onChange({ outlineWidthScale: Number(event.target.value) })
        }
      />
    </div>
  );
}

const ALIGN_LABEL_KEYS: Record<"left" | "center" | "right", string> = {
  left: "settings.format.alignment.left",
  center: "settings.format.alignment.center",
  right: "settings.format.alignment.right",
};

function AlignIcon({
  align,
}: {
  align: "left" | "center" | "right";
}): React.JSX.Element {
  if (align === "left") {
    return <AlignLeftIcon size={18} />;
  }
  if (align === "right") {
    return <AlignRightIcon size={18} />;
  }
  return <AlignCenterIcon size={18} />;
}

function clampFontSize(value: number): number {
  if (!Number.isFinite(value)) {
    return 24;
  }
  return Math.max(10, Math.min(160, Math.round(value)));
}

function round2(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 100) / 100;
}
