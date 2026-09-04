import React from "react";
import { useTranslation } from "react-i18next";
import type {
  GatherTextDirectFormatModel,
  GatherTextDirectFormatPatch,
  GatherTextDirectFormatValues,
} from "../../lib/gatherTextDirectFormatModel";
import {
  BlockTypographyChoiceGroup,
  BlockTypographyFontPicker,
  BlockTypographyPillToggle,
  BlockTypographySizeStepper,
  BlockTypographyToolButton,
} from "../blockFormat/BlockTypographyPrimitives";
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BoldIcon,
  ItalicIcon,
} from "../ui/icons";
import { DirectSectionHeading } from "./GatherTextDirectFormatPrimitives";
import {
  hasDirectFormatField,
  resolveControlState,
  resolvePreviewValue,
  type DirectChangeHandler,
} from "./gatherTextDirectFormatUi";

type TypographyControlProps = {
  disabled: boolean;
  model: GatherTextDirectFormatModel;
  patch: GatherTextDirectFormatPatch;
  onChange: DirectChangeHandler;
  onFontSizeChange: (value: number) => void;
};

type TypographyField =
  | "fontFamily"
  | "fontSizePx"
  | "autoFitText"
  | "bold"
  | "italic"
  | "textAlign"
  | "renderDirection";

type TypographyValues = {
  [Field in TypographyField]: {
    value: GatherTextDirectFormatValues[Field];
    mixed: boolean;
    touched: boolean;
  };
};

export function GatherTextDirectTypographyControls({
  disabled,
  model,
  patch,
  onChange,
  onFontSizeChange,
}: TypographyControlProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const values = buildTypographyValues(model, patch);
  return (
    <section className="gather-direct-editor-section">
      <DirectSectionHeading
        title={t("gatherText.typographySection")}
        description={t("gatherText.changedOnlyHint")}
      />
      <GatherTypographyTypeRow
        disabled={disabled}
        values={values}
        onChange={onChange}
        onFontSizeChange={onFontSizeChange}
      />
      <GatherTypographyToolbar
        disabled={disabled}
        values={values}
        onChange={onChange}
      />
    </section>
  );
}

function GatherTypographyTypeRow({
  disabled,
  values,
  onChange,
  onFontSizeChange,
}: Pick<
  TypographyControlProps,
  "disabled" | "onChange" | "onFontSizeChange"
> & {
  values: TypographyValues;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const autoFitPressed = !values.autoFitText.mixed && values.autoFitText.value;
  return (
    <div className="gather-direct-editor-type-row">
      <BlockTypographyFontPicker
        disabled={disabled}
        fontFamily={values.fontFamily.value}
        label={t("formatBatch.groups.font")}
        mixed={values.fontFamily.mixed}
        touched={values.fontFamily.touched}
        onChange={(value) => onChange("fontFamily", value)}
      />
      <BlockTypographySizeStepper
        decreaseLabel={t("format.fontSizeDecrease")}
        disabled={disabled}
        increaseLabel={t("format.fontSizeIncrease")}
        label={t("format.fontSize")}
        mixed={values.fontSizePx.mixed}
        touched={values.fontSizePx.touched}
        value={values.fontSizePx.value}
        onChange={onFontSizeChange}
      />
      <BlockTypographyPillToggle
        disabled={disabled}
        label={t("gatherText.autoFitLabel")}
        mixed={values.autoFitText.mixed}
        pressed={autoFitPressed}
        text={t(
          autoFitPressed ? "gatherText.toggleOn" : "gatherText.toggleOff",
        )}
        touched={values.autoFitText.touched}
        onClick={() =>
          onChange(
            "autoFitText",
            values.autoFitText.mixed ? true : !values.autoFitText.value,
          )
        }
      />
    </div>
  );
}

type GatherToolbarProps = Pick<
  TypographyControlProps,
  "disabled" | "onChange"
> & {
  values: TypographyValues;
};

function GatherTypographyToolbar(props: GatherToolbarProps): React.JSX.Element {
  return (
    <div className="gather-direct-style-toolbar">
      <GatherEmphasisTools {...props} />
      <span className="gather-direct-toolbar-divider" aria-hidden="true" />
      <GatherAlignmentTools {...props} />
      <span className="gather-direct-toolbar-divider" aria-hidden="true" />
      <GatherDirectionTools {...props} />
    </div>
  );
}

function GatherEmphasisTools({
  disabled,
  values,
  onChange,
}: GatherToolbarProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="gather-direct-toolbar-group">
      {(["bold", "italic"] as const).map((field) => (
        <BlockTypographyToolButton
          key={field}
          label={t(`format.${field}`)}
          mixed={values[field].mixed}
          pressed={!values[field].mixed && values[field].value}
          touched={values[field].touched}
          disabled={disabled}
          onClick={() =>
            onChange(field, values[field].mixed ? true : !values[field].value)
          }
        >
          {field === "bold" ? <BoldIcon size={17} /> : <ItalicIcon size={17} />}
        </BlockTypographyToolButton>
      ))}
    </div>
  );
}

function GatherAlignmentTools({
  disabled,
  values,
  onChange,
}: GatherToolbarProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const choices = [
    {
      value: "left",
      label: t("format.align.left"),
      content: <AlignLeftIcon size={17} />,
    },
    {
      value: "center",
      label: t("format.align.center"),
      content: <AlignCenterIcon size={17} />,
    },
    {
      value: "right",
      label: t("format.align.right"),
      content: <AlignRightIcon size={17} />,
    },
  ] as const;
  return (
    <BlockTypographyChoiceGroup
      choices={choices}
      disabled={disabled}
      mixed={values.textAlign.mixed}
      selectedValue={
        values.textAlign.mixed ? undefined : values.textAlign.value
      }
      touched={values.textAlign.touched}
      onChange={(value) => onChange("textAlign", value)}
    />
  );
}

function GatherDirectionTools({
  disabled,
  values,
  onChange,
}: GatherToolbarProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const choices = (["horizontal", "vertical"] as const).map((value) => ({
    value,
    label: t(`format.direction.${value}`),
    content: <span>{t(`format.direction.${value}`)}</span>,
  }));
  return (
    <BlockTypographyChoiceGroup
      choices={choices}
      direction
      disabled={disabled}
      mixed={values.renderDirection.mixed}
      selectedValue={
        values.renderDirection.mixed ? undefined : values.renderDirection.value
      }
      touched={values.renderDirection.touched}
      onChange={(value) => onChange("renderDirection", value)}
    />
  );
}

function buildTypographyValues(
  model: GatherTextDirectFormatModel,
  patch: GatherTextDirectFormatPatch,
): TypographyValues {
  const resolveValue = <Field extends TypographyField>(field: Field) => ({
    value: resolvePreviewValue(model, patch, field),
    mixed: resolveControlState(model.values, patch, field).kind === "mixed",
    touched: hasDirectFormatField(patch, field),
  });
  return {
    fontFamily: resolveValue("fontFamily"),
    fontSizePx: resolveValue("fontSizePx"),
    autoFitText: resolveValue("autoFitText"),
    bold: resolveValue("bold"),
    italic: resolveValue("italic"),
    textAlign: resolveValue("textAlign"),
    renderDirection: resolveValue("renderDirection"),
  };
}
