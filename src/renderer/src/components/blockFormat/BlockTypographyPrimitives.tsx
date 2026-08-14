import React from "react";
import { DEFAULT_BLOCK_FONT_ID } from "../../../../shared/blockFontCatalog";
import { useFonts } from "../../fonts/useFonts";
import { FontSizeNumberInput } from "../FontSizeNumberInput";
import { Select } from "../ui/Select";
import { BlockFormatControlCaption } from "./BlockFormatPrimitives";

const DEFAULT_FONT_VALUE = "__block_format_default_font__";
const MIXED_FONT_VALUE = "__block_format_mixed_font__";
const MINIMUM_FONT_SIZE = 10;
const MAXIMUM_FONT_SIZE = 160;

export function BlockTypographyFontPicker({
  defaultLabel,
  disabled = false,
  fontFamily,
  label,
  mixed = false,
  mixedLabel,
  touched = false,
  onChange,
}: {
  defaultLabel: string;
  disabled?: boolean;
  fontFamily: string | undefined;
  label: string;
  mixed?: boolean;
  mixedLabel: string;
  touched?: boolean;
  onChange: (fontFamily: string | undefined) => void;
}): React.JSX.Element {
  const { options } = useFonts();
  const defaultOption = options.find(
    (option) => option.id === DEFAULT_BLOCK_FONT_ID,
  );
  return (
    <label
      className="gather-direct-font-picker"
      data-touched={touched || undefined}
    >
      <BlockFormatControlCaption
        label={label}
        mixed={mixed}
        touched={touched}
      />
      <Select
        ariaLabel={label}
        value={mixed ? MIXED_FONT_VALUE : (fontFamily ?? DEFAULT_FONT_VALUE)}
        disabled={disabled}
        options={[
          ...(mixed
            ? [
                {
                  value: MIXED_FONT_VALUE,
                  label: mixedLabel,
                  disabled: true,
                },
              ]
            : []),
          {
            value: DEFAULT_FONT_VALUE,
            label: defaultOption?.label ?? defaultLabel,
          },
          ...options
            .filter((option) => option.id !== DEFAULT_BLOCK_FONT_ID)
            .map((option) => ({ value: option.id, label: option.label })),
        ]}
        searchable="auto"
        onValueChange={(value) =>
          onChange(value === DEFAULT_FONT_VALUE ? undefined : value)
        }
      />
    </label>
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
  const updateRelative = (delta: -1 | 1): void =>
    onChange(
      Math.max(
        MINIMUM_FONT_SIZE,
        Math.min(MAXIMUM_FONT_SIZE, Math.round(value) + delta),
      ),
    );
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
      <div className="gather-direct-size-stepper">
        <button
          type="button"
          aria-label={decreaseLabel}
          disabled={disabled || value <= MINIMUM_FONT_SIZE}
          onClick={() => updateRelative(-1)}
        >
          −
        </button>
        <FontSizeNumberInput
          className="gather-direct-size-input"
          ariaLabel={label}
          value={value}
          mixed={mixed}
          disabled={disabled}
          onValueChange={onChange}
        />
        <button
          type="button"
          aria-label={increaseLabel}
          disabled={disabled || value >= MAXIMUM_FONT_SIZE}
          onClick={() => updateRelative(1)}
        >
          +
        </button>
      </div>
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
