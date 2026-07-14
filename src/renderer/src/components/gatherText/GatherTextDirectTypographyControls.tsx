import React from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_BLOCK_FONT_ID } from "../../../../shared/blockFontCatalog";
import { useFonts } from "../../fonts/useFonts";
import type {
  GatherTextDirectFormatModel,
  GatherTextDirectFormatPatch,
  GatherTextDirectFormatValueStates,
} from "../../lib/gatherTextDirectFormatModel";
import { FontSizeNumberInput } from "../FontSizeNumberInput";
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BoldIcon,
  ItalicIcon,
} from "../ui/icons";
import {
  DirectControlCaption,
  DirectSectionHeading,
} from "./GatherTextDirectFormatPrimitives";
import {
  clampDirectFormatValue,
  hasDirectFormatField,
  resolveControlState,
  resolvePreviewValue,
  type DirectChangeHandler,
} from "./gatherTextDirectFormatUi";

const MIXED_FONT_VALUE = "__gather_mixed_font__";
const DEFAULT_FONT_VALUE = "__gather_default_font__";

type TypographyControlProps = {
  disabled: boolean;
  model: GatherTextDirectFormatModel;
  patch: GatherTextDirectFormatPatch;
  onChange: DirectChangeHandler;
  onFontSizeChange: (value: number) => void;
};

export function GatherTextDirectTypographyControls({
  disabled,
  model,
  patch,
  onChange,
  onFontSizeChange,
}: TypographyControlProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="gather-direct-editor-section">
      <DirectSectionHeading
        title={t("gatherText.typographySection")}
        description={t("gatherText.changedOnlyHint")}
      />
      <div className="gather-direct-editor-type-row">
        <FontPicker
          disabled={disabled}
          patch={patch}
          states={model.values}
          onChange={onChange}
        />
        <FontSizeStepper
          disabled={disabled}
          model={model}
          patch={patch}
          onChange={onFontSizeChange}
        />
        <AutoFitToggle
          disabled={disabled}
          patch={patch}
          states={model.values}
          onChange={onChange}
        />
      </div>
      <StyleToolbar
        disabled={disabled}
        patch={patch}
        states={model.values}
        onChange={onChange}
      />
    </section>
  );
}

function FontPicker({
  disabled,
  patch,
  states,
  onChange,
}: {
  disabled: boolean;
  patch: GatherTextDirectFormatPatch;
  states: GatherTextDirectFormatValueStates;
  onChange: DirectChangeHandler;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const { options } = useFonts();
  const state = resolveControlState(states, patch, "fontFamily");
  const touched = hasDirectFormatField(patch, "fontFamily");
  const value =
    state.kind === "mixed"
      ? MIXED_FONT_VALUE
      : (state.value ?? DEFAULT_FONT_VALUE);
  const defaultOption = options.find(
    (option) => option.id === DEFAULT_BLOCK_FONT_ID,
  );
  return (
    <label
      className="gather-direct-font-picker"
      data-touched={touched || undefined}
    >
      <DirectControlCaption
        label={t("formatBatch.groups.font")}
        mixed={state.kind === "mixed"}
        touched={touched}
      />
      <select
        aria-label={t("formatBatch.groups.font")}
        value={value}
        disabled={disabled}
        onChange={(event) =>
          onChange(
            "fontFamily",
            event.target.value === DEFAULT_FONT_VALUE
              ? undefined
              : event.target.value,
          )
        }
      >
        {state.kind === "mixed" ? (
          <option value={MIXED_FONT_VALUE} disabled>
            {t("gatherText.mixedValue")}
          </option>
        ) : null}
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

function FontSizeStepper({
  disabled,
  model,
  patch,
  onChange,
}: {
  disabled: boolean;
  model: GatherTextDirectFormatModel;
  patch: GatherTextDirectFormatPatch;
  onChange: (value: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const state = resolveControlState(model.values, patch, "fontSizePx");
  const touched = hasDirectFormatField(patch, "fontSizePx");
  const value = resolvePreviewValue(model, patch, "fontSizePx");
  const setRelative = (delta: -1 | 1) =>
    onChange(clampDirectFormatValue(Math.round(value) + delta, 10, 160));
  return (
    <div
      className="gather-direct-size-control"
      data-touched={touched || undefined}
    >
      <DirectControlCaption
        label={t("format.fontSize")}
        mixed={state.kind === "mixed"}
        touched={touched}
      />
      <div className="gather-direct-size-stepper">
        <button
          type="button"
          aria-label={t("format.fontSizeDecrease")}
          disabled={disabled || value <= 10}
          onClick={() => setRelative(-1)}
        >
          −
        </button>
        <FontSizeNumberInput
          className="gather-direct-size-input"
          ariaLabel={t("format.fontSize")}
          value={value}
          mixed={state.kind === "mixed" && !touched}
          disabled={disabled}
          onValueChange={onChange}
        />
        <button
          type="button"
          aria-label={t("format.fontSizeIncrease")}
          disabled={disabled || value >= 160}
          onClick={() => setRelative(1)}
        >
          +
        </button>
      </div>
    </div>
  );
}

function AutoFitToggle({
  disabled,
  patch,
  states,
  onChange,
}: {
  disabled: boolean;
  patch: GatherTextDirectFormatPatch;
  states: GatherTextDirectFormatValueStates;
  onChange: DirectChangeHandler;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const state = resolveControlState(states, patch, "autoFitText");
  const touched = hasDirectFormatField(patch, "autoFitText");
  const pressed = state.kind === "common" && state.value;
  return (
    <div className="gather-direct-auto-control">
      <DirectControlCaption
        label={t("gatherText.autoFitLabel")}
        mixed={state.kind === "mixed"}
        touched={touched}
      />
      <button
        type="button"
        className="gather-direct-pill-toggle"
        data-touched={touched || undefined}
        aria-pressed={state.kind === "mixed" ? "mixed" : pressed}
        disabled={disabled}
        onClick={() =>
          onChange("autoFitText", state.kind === "mixed" ? true : !state.value)
        }
      >
        <span aria-hidden="true" />
        {pressed ? t("gatherText.toggleOn") : t("gatherText.toggleOff")}
      </button>
    </div>
  );
}

function StyleToolbar({
  disabled,
  patch,
  states,
  onChange,
}: {
  disabled: boolean;
  patch: GatherTextDirectFormatPatch;
  states: GatherTextDirectFormatValueStates;
  onChange: DirectChangeHandler;
}): React.JSX.Element {
  return (
    <div className="gather-direct-style-toolbar">
      <EmphasisTools {...{ disabled, patch, states, onChange }} />
      <span className="gather-direct-toolbar-divider" aria-hidden="true" />
      <AlignmentTools {...{ disabled, patch, states, onChange }} />
      <span className="gather-direct-toolbar-divider" aria-hidden="true" />
      <DirectionTools {...{ disabled, patch, states, onChange }} />
    </div>
  );
}

type ToolbarGroupProps = Omit<
  TypographyControlProps,
  "model" | "onFontSizeChange"
> & {
  states: GatherTextDirectFormatValueStates;
};

function EmphasisTools({
  disabled,
  patch,
  states,
  onChange,
}: ToolbarGroupProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const bold = resolveControlState(states, patch, "bold");
  const italic = resolveControlState(states, patch, "italic");
  return (
    <div className="gather-direct-toolbar-group">
      <DirectToolButton
        label={t("format.bold")}
        mixed={bold.kind === "mixed"}
        pressed={bold.kind === "common" && bold.value}
        touched={hasDirectFormatField(patch, "bold")}
        disabled={disabled}
        onClick={() =>
          onChange("bold", bold.kind === "mixed" ? true : !bold.value)
        }
      >
        <BoldIcon size={17} />
      </DirectToolButton>
      <DirectToolButton
        label={t("format.italic")}
        mixed={italic.kind === "mixed"}
        pressed={italic.kind === "common" && italic.value}
        touched={hasDirectFormatField(patch, "italic")}
        disabled={disabled}
        onClick={() =>
          onChange("italic", italic.kind === "mixed" ? true : !italic.value)
        }
      >
        <ItalicIcon size={17} />
      </DirectToolButton>
    </div>
  );
}

function AlignmentTools({
  disabled,
  patch,
  states,
  onChange,
}: ToolbarGroupProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const align = resolveControlState(states, patch, "textAlign");
  const tools = [
    ["left", t("format.align.left"), <AlignLeftIcon size={17} />],
    ["center", t("format.align.center"), <AlignCenterIcon size={17} />],
    ["right", t("format.align.right"), <AlignRightIcon size={17} />],
  ] as const;
  return (
    <div className="gather-direct-toolbar-group">
      {tools.map(([value, label, icon]) => (
        <DirectToolButton
          key={value}
          label={label}
          mixed={align.kind === "mixed"}
          pressed={align.kind === "common" && align.value === value}
          touched={hasDirectFormatField(patch, "textAlign")}
          disabled={disabled}
          onClick={() => onChange("textAlign", value)}
        >
          {icon}
        </DirectToolButton>
      ))}
    </div>
  );
}

function DirectionTools({
  disabled,
  patch,
  states,
  onChange,
}: ToolbarGroupProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const direction = resolveControlState(states, patch, "renderDirection");
  return (
    <div className="gather-direct-toolbar-group direction">
      {(["horizontal", "vertical"] as const).map((value) => (
        <DirectToolButton
          key={value}
          label={t(`format.direction.${value}`)}
          mixed={direction.kind === "mixed"}
          pressed={direction.kind === "common" && direction.value === value}
          touched={hasDirectFormatField(patch, "renderDirection")}
          disabled={disabled}
          onClick={() => onChange("renderDirection", value)}
        >
          <span>{t(`format.direction.${value}`)}</span>
        </DirectToolButton>
      ))}
    </div>
  );
}

function DirectToolButton({
  children,
  disabled,
  label,
  mixed,
  pressed,
  touched,
  onClick,
}: {
  children: React.ReactNode;
  disabled: boolean;
  label: string;
  mixed: boolean;
  pressed: boolean;
  touched: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="gather-direct-tool-button"
      aria-label={label}
      title={label}
      aria-pressed={mixed && !touched ? "mixed" : pressed}
      data-touched={touched || undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
