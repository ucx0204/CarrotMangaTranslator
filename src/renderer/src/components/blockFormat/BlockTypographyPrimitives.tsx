import React from "react";
import {
  FONT_SIZE_STEP_PX,
  MAX_FONT_SIZE_PX,
  MIN_FONT_SIZE_PX,
} from "../../../../shared/blockFormatValues";
import { FontSelect } from "../FontSelect";
import { NumberField } from "../ui/NumberField";
import { BlockFormatControlCaption } from "./BlockFormatPrimitives";

export function BlockTypographyFontPicker({
  disabled = false,
  fontFamily,
  label,
  mixed = false,
  touched = false,
  onChange,
}: {
  disabled?: boolean;
  fontFamily: string | undefined;
  label: string;
  mixed?: boolean;
  touched?: boolean;
  onChange: (fontFamily: string | undefined) => void;
}): React.JSX.Element {
  return (
    <div
      className="gather-direct-font-picker"
      data-touched={touched || undefined}
    >
      <BlockFormatControlCaption
        label={label}
        mixed={mixed}
        touched={touched}
      />
      <FontSelect
        ariaLabel={label}
        disabled={disabled}
        mixed={mixed}
        value={fontFamily}
        onChange={onChange}
      />
    </div>
  );
}

export function BlockTypographySizeStepper({
  decreaseLabel,
  disabled = false,
  increaseLabel,
  label,
  mixed = false,
  touched = false,
  value,
  onChange,
}: {
  decreaseLabel: string;
  disabled?: boolean;
  increaseLabel: string;
  label: string;
  mixed?: boolean;
  touched?: boolean;
  value: number;
  onChange: (value: number) => void;
}): React.JSX.Element {
  return (
    <div
      className="gather-direct-size-control"
      data-touched={touched || undefined}
    >
      <BlockFormatControlCaption
        label={label}
        mixed={mixed}
        touched={touched}
      />
      <NumberField
        variant="scrubber"
        ariaLabel={label}
        decreaseLabel={decreaseLabel}
        increaseLabel={increaseLabel}
        min={MIN_FONT_SIZE_PX}
        max={MAX_FONT_SIZE_PX}
        step={FONT_SIZE_STEP_PX}
        precision={1}
        value={value}
        mixed={mixed}
        disabled={disabled}
        unit="px"
        onValueChange={onChange}
      />
    </div>
  );
}

export function BlockTypographyPillToggle({
  disabled = false,
  label,
  mixed = false,
  pressed,
  text,
  touched = false,
  onClick,
}: {
  disabled?: boolean;
  label: string;
  mixed?: boolean;
  pressed: boolean;
  text: string;
  touched?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <div className="gather-direct-auto-control">
      <BlockFormatControlCaption
        label={label}
        mixed={mixed}
        touched={touched}
      />
      <button
        type="button"
        className="gather-direct-pill-toggle"
        data-touched={touched || undefined}
        aria-pressed={mixed ? "mixed" : pressed}
        disabled={disabled}
        onClick={onClick}
      >
        <span aria-hidden="true" />
        {text}
      </button>
    </div>
  );
}

type BlockTypographyChoice<Value extends string> = Readonly<{
  value: Value;
  label: string;
  content: React.ReactNode;
}>;

export function BlockTypographyChoiceGroup<Value extends string>({
  choices,
  direction = false,
  disabled = false,
  mixed = false,
  selectedValue,
  touched = false,
  onChange,
}: {
  choices: readonly BlockTypographyChoice<Value>[];
  direction?: boolean;
  disabled?: boolean;
  mixed?: boolean;
  selectedValue: Value | undefined;
  touched?: boolean;
  onChange: (value: Value) => void;
}): React.JSX.Element {
  return (
    <div
      className={`gather-direct-toolbar-group${direction ? " direction" : ""}`}
    >
      {choices.map((choice) => (
        <BlockTypographyToolButton
          key={choice.value}
          label={choice.label}
          mixed={mixed}
          pressed={selectedValue === choice.value}
          touched={touched}
          disabled={disabled}
          onClick={() => onChange(choice.value)}
        >
          {choice.content}
        </BlockTypographyToolButton>
      ))}
    </div>
  );
}

export function BlockTypographyToolButton({
  children,
  disabled = false,
  label,
  mixed = false,
  pressed,
  touched = false,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  mixed?: boolean;
  pressed: boolean;
  touched?: boolean;
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
