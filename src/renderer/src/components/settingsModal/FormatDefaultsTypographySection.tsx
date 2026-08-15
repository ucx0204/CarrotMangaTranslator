import React from "react";
import { useTranslation } from "react-i18next";
import type {
  BlockFormatDefaults,
  BlockFormatDirectionDefault,
} from "../../../../shared/settingsTypes";
import { clampFontSizePx } from "../../../../shared/blockFormatValues";
import {
  BlockTypographyChoiceGroup,
  BlockTypographyFontPicker,
  BlockTypographyPillToggle,
  BlockTypographySizeStepper,
  BlockTypographyToolButton,
} from "../blockFormat/BlockTypographyPrimitives";
import { BlockFormatSectionHeading as DirectSectionHeading } from "../blockFormat/BlockFormatPrimitives";
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BoldIcon,
  ItalicIcon,
} from "../ui/icons";
import {
  PresetGroupControl,
  type PresetGroupAvailability,
} from "./PresetGroupControl";

const DIRECTION_OPTIONS: {
  id: BlockFormatDirectionDefault;
  labelKey: string;
}[] = [
  { id: "auto", labelKey: "settings.format.direction.auto" },
  { id: "horizontal", labelKey: "settings.format.direction.horizontal" },
  { id: "vertical", labelKey: "settings.format.direction.vertical" },
];

type FormatChange = (patch: Partial<BlockFormatDefaults>) => void;

type DefaultsTypographyProps = {
  allowAutoDirection: boolean;
  presetGroups?: PresetGroupAvailability;
  value: BlockFormatDefaults;
  onChange: FormatChange;
};

export function FormatDefaultsTypographySection({
  allowAutoDirection,
  presetGroups,
  value,
  onChange,
}: DefaultsTypographyProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="gather-direct-editor-section">
      <DirectSectionHeading title={t("gatherText.typographySection")} />
      <DefaultsTypographyTypeRow
        presetGroups={presetGroups}
        value={value}
        onChange={onChange}
      />
      <DefaultsTypographyToolbar
        allowAutoDirection={allowAutoDirection}
        presetGroups={presetGroups}
        value={value}
        onChange={onChange}
      />
    </section>
  );
}

function DefaultsTypographyTypeRow({
  presetGroups,
  value,
  onChange,
}: Omit<DefaultsTypographyProps, "allowAutoDirection">): React.JSX.Element {
  const { t } = useTranslation("components");
  const updateFontSize = (fontSizePx: number): void =>
    onChange({ fontSizePx: clampFontSizePx(fontSizePx), autoFitText: false });
  return (
    <div className="gather-direct-editor-type-row">
      <PresetGroupControl availability={presetGroups} groupId="font">
        <BlockTypographyFontPicker
          defaultLabel={t("gatherText.defaultFont")}
          fontFamily={value.fontFamily}
          label={t("formatBatch.groups.font")}
          mixedLabel={t("gatherText.mixedValue")}
          onChange={(fontFamily) => onChange({ fontFamily })}
        />
      </PresetGroupControl>
      <PresetGroupControl availability={presetGroups} groupId="size">
        <BlockTypographySizeStepper
          decreaseLabel={t("format.fontSizeDecrease")}
          increaseLabel={t("format.fontSizeIncrease")}
          label={t("format.fontSize")}
          value={value.fontSizePx}
          onChange={updateFontSize}
        />
      </PresetGroupControl>
      <PresetGroupControl
        availability={presetGroups}
        className="format-preset-auto-control-guard"
        groupId="size"
      >
        <BlockTypographyPillToggle
          label={t("gatherText.autoFitLabel")}
          pressed={value.autoFitText}
          text={t(
            value.autoFitText ? "gatherText.toggleOn" : "gatherText.toggleOff",
          )}
          onClick={() => onChange({ autoFitText: !value.autoFitText })}
        />
      </PresetGroupControl>
    </div>
  );
}

function DefaultsTypographyToolbar({
  allowAutoDirection,
  presetGroups,
  value,
  onChange,
}: DefaultsTypographyProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const alignChoices = [
    {
      value: "left",
      label: t("settings.format.alignment.left"),
      content: <AlignLeftIcon size={17} />,
    },
    {
      value: "center",
      label: t("settings.format.alignment.center"),
      content: <AlignCenterIcon size={17} />,
    },
    {
      value: "right",
      label: t("settings.format.alignment.right"),
      content: <AlignRightIcon size={17} />,
    },
  ] as const;
  const directionChoices = DIRECTION_OPTIONS.filter(
    (option) => allowAutoDirection || option.id !== "auto",
  ).map((option) => ({
    value: option.id,
    label: t(option.labelKey),
    content: <span>{t(option.labelKey)}</span>,
  }));
  return (
    <div className="gather-direct-style-toolbar">
      <PresetToolbarGroup availability={presetGroups} groupId="emphasis">
        <div className="gather-direct-toolbar-group">
          {(["bold", "italic"] as const).map((field) => (
            <BlockTypographyToolButton
              key={field}
              label={t(`settings.format.alignment.${field}`)}
              pressed={value[field]}
              onClick={() => onChange({ [field]: !value[field] })}
            >
              {field === "bold" ? (
                <BoldIcon size={17} />
              ) : (
                <ItalicIcon size={17} />
              )}
            </BlockTypographyToolButton>
          ))}
        </div>
      </PresetToolbarGroup>
      <span className="gather-direct-toolbar-divider" aria-hidden="true" />
      <PresetToolbarGroup availability={presetGroups} groupId="align">
        <BlockTypographyChoiceGroup
          choices={alignChoices}
          selectedValue={value.textAlign}
          onChange={(textAlign) => onChange({ textAlign })}
        />
      </PresetToolbarGroup>
      <span className="gather-direct-toolbar-divider" aria-hidden="true" />
      <PresetToolbarGroup availability={presetGroups} groupId="direction">
        <BlockTypographyChoiceGroup
          choices={directionChoices}
          direction
          selectedValue={value.renderDirection}
          onChange={(renderDirection) => onChange({ renderDirection })}
        />
      </PresetToolbarGroup>
    </div>
  );
}

function PresetToolbarGroup({
  availability,
  children,
  groupId,
}: {
  availability: PresetGroupAvailability | undefined;
  children: React.ReactNode;
  groupId: "align" | "direction" | "emphasis";
}): React.JSX.Element {
  return (
    <PresetGroupControl
      availability={availability}
      className="format-preset-toolbar-guard"
      groupId={groupId}
    >
      {children}
    </PresetGroupControl>
  );
}
