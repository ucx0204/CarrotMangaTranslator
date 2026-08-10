import React from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_BLOCK_FONT_ID } from "../../../../shared/blockFontCatalog";
import type {
  BlockFormatDefaults,
  BlockFormatDirectionDefault,
} from "../../../../shared/settingsTypes";
import { useFonts } from "../../fonts/useFonts";
import { FontSizeNumberInput } from "../FontSizeNumberInput";
import {
  BlockFormatControlCaption as DirectControlCaption,
  BlockFormatSectionHeading as DirectSectionHeading,
} from "../blockFormat/BlockFormatPrimitives";
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BoldIcon,
  ItalicIcon,
} from "../ui/icons";
import { Select } from "../ui/Select";
import {
  PresetGroupControl,
  type PresetGroupAvailability,
} from "./PresetGroupControl";

const DEFAULT_FONT_VALUE = "__format_defaults_font__";
const DIRECTION_OPTIONS: {
  id: BlockFormatDirectionDefault;
  labelKey: string;
}[] = [
  { id: "auto", labelKey: "settings.format.direction.auto" },
  { id: "horizontal", labelKey: "settings.format.direction.horizontal" },
  { id: "vertical", labelKey: "settings.format.direction.vertical" },
];

type FormatChange = (patch: Partial<BlockFormatDefaults>) => void;

export function FormatDefaultsTypographySection({
  allowAutoDirection,
  presetGroups,
  value,
  onChange,
}: {
  allowAutoDirection: boolean;
  presetGroups?: PresetGroupAvailability;
  value: BlockFormatDefaults;
  onChange: FormatChange;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="gather-direct-editor-section">
      <DirectSectionHeading title={t("gatherText.typographySection")} />
      <div className="gather-direct-editor-type-row">
        <PresetGroupControl availability={presetGroups} groupId="font">
          <DefaultFontPicker value={value.fontFamily} onChange={onChange} />
        </PresetGroupControl>
        <PresetGroupControl availability={presetGroups} groupId="size">
          <DefaultFontSizeControl value={value} onChange={onChange} />
        </PresetGroupControl>
        <PresetGroupControl
          availability={presetGroups}
          className="format-preset-auto-control-guard"
          groupId="size"
        >
          <DefaultAutoFitControl
            value={value.autoFitText}
            onChange={onChange}
          />
        </PresetGroupControl>
      </div>
      <DefaultStyleToolbar
        allowAutoDirection={allowAutoDirection}
        presetGroups={presetGroups}
        value={value}
        onChange={onChange}
      />
    </section>
  );
}

function DefaultFontPicker({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: FormatChange;
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
      <Select
        ariaLabel={t("formatBatch.groups.font")}
        value={value ?? DEFAULT_FONT_VALUE}
        options={[
          {
            value: DEFAULT_FONT_VALUE,
            label: defaultOption?.label ?? t("gatherText.defaultFont"),
          },
          ...options
            .filter((option) => option.id !== DEFAULT_BLOCK_FONT_ID)
            .map((option) => ({ value: option.id, label: option.label })),
        ]}
        searchable="auto"
        onValueChange={(nextValue) =>
          onChange({
            fontFamily:
              nextValue === DEFAULT_FONT_VALUE ? undefined : nextValue,
          })
        }
      />
    </label>
  );
}

function DefaultFontSizeControl({
  value,
  onChange,
}: {
  value: BlockFormatDefaults;
  onChange: FormatChange;
}): React.JSX.Element {
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
  onChange: FormatChange;
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
  allowAutoDirection,
  presetGroups,
  value,
  onChange,
}: {
  allowAutoDirection: boolean;
  presetGroups?: PresetGroupAvailability;
  value: BlockFormatDefaults;
  onChange: FormatChange;
}): React.JSX.Element {
  return (
    <div className="gather-direct-style-toolbar">
      <EmphasisTools
        presetGroups={presetGroups}
        value={value}
        onChange={onChange}
      />
      <span className="gather-direct-toolbar-divider" aria-hidden="true" />
      <AlignmentTools
        presetGroups={presetGroups}
        value={value}
        onChange={onChange}
      />
      <span className="gather-direct-toolbar-divider" aria-hidden="true" />
      <DirectionTools
        allowAutoDirection={allowAutoDirection}
        presetGroups={presetGroups}
        value={value}
        onChange={onChange}
      />
    </div>
  );
}

function EmphasisTools({
  presetGroups,
  value,
  onChange,
}: {
  presetGroups?: PresetGroupAvailability;
  value: BlockFormatDefaults;
  onChange: FormatChange;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <PresetGroupControl
      availability={presetGroups}
      className="format-preset-toolbar-guard"
      groupId="emphasis"
    >
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
    </PresetGroupControl>
  );
}

function AlignmentTools({
  presetGroups,
  value,
  onChange,
}: {
  presetGroups?: PresetGroupAvailability;
  value: BlockFormatDefaults;
  onChange: FormatChange;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const tools = [
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
    <PresetGroupControl
      availability={presetGroups}
      className="format-preset-toolbar-guard"
      groupId="align"
    >
      <div className="gather-direct-toolbar-group">
        {tools.map(([alignment, label, icon]) => (
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
    </PresetGroupControl>
  );
}

function DirectionTools({
  allowAutoDirection,
  presetGroups,
  value,
  onChange,
}: {
  allowAutoDirection: boolean;
  presetGroups?: PresetGroupAvailability;
  value: BlockFormatDefaults;
  onChange: FormatChange;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const options = DIRECTION_OPTIONS.filter(
    (option) => allowAutoDirection || option.id !== "auto",
  );
  return (
    <PresetGroupControl
      availability={presetGroups}
      className="format-preset-toolbar-guard"
      groupId="direction"
    >
      <div className="gather-direct-toolbar-group direction">
        {options.map((option) => (
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
    </PresetGroupControl>
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

function clampFontSize(value: number): number {
  if (!Number.isFinite(value)) return 24;
  return Math.max(10, Math.min(160, Math.round(value)));
}
