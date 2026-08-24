import React from "react";
import { useTranslation } from "react-i18next";
import { CheckboxField } from "./ui/CheckboxField";
import { SegmentedControl } from "./ui/SegmentedControl";

export function TranslationOptionSection({
  className,
  title,
  children,
}: {
  className?: string;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const titleId = React.useId();
  return (
    <section
      className={["translate-options-section", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      aria-labelledby={titleId}
    >
      <h3 id={titleId} className="translate-options-section-title">
        {title}
      </h3>
      <div className="translate-options-section-body">{children}</div>
    </section>
  );
}

export function TranslationCompletionOptions({
  bubbleLayoutWorkflow,
  eraseOriginalWorkflow,
  onBubbleLayoutWorkflowChange,
  onEraseOriginalWorkflowChange,
}: {
  bubbleLayoutWorkflow: boolean;
  eraseOriginalWorkflow: boolean;
  onBubbleLayoutWorkflowChange: (enabled: boolean) => void;
  onEraseOriginalWorkflowChange: (enabled: boolean) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <OptionRow
        label={t("translationOptions.completionMode")}
        options={[
          {
            id: "translate",
            label: t("translationOptions.completionModeTranslate"),
          },
          {
            id: "erase",
            label: t("translationOptions.completionModeErase"),
          },
        ]}
        value={eraseOriginalWorkflow ? "erase" : "translate"}
        onChange={(value) => onEraseOriginalWorkflowChange(value === "erase")}
        description={t(
          `translationOptions.completionModeSummaries.${eraseOriginalWorkflow ? "erase" : "translate"}`,
        )}
        showLabel={false}
      />
      {eraseOriginalWorkflow ? (
        <div className="translate-options-nested">
          <ToggleOptionRow
            label={t("translationOptions.bubbleLayoutWorkflow")}
            pressed={bubbleLayoutWorkflow}
            onChange={onBubbleLayoutWorkflowChange}
            description={t(
              `translationOptions.bubbleLayoutWorkflowSummaries.${bubbleLayoutWorkflow ? "on" : "off"}`,
            )}
          />
        </div>
      ) : null}
    </>
  );
}

export function ToggleOptionRow({
  label,
  pressed,
  onChange,
  description,
  disabled = false,
}: {
  label: string;
  pressed: boolean;
  onChange: (pressed: boolean) => void;
  description?: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <CheckboxField
      variant="switch"
      className="translate-options-switch"
      checked={pressed}
      ariaLabel={label}
      disabled={disabled}
      onCheckedChange={onChange}
      label={
        <span className="translate-options-switch-copy">
          <strong>{label}</strong>
          {description ? <small>{description}</small> : null}
        </span>
      }
    />
  );
}

export function OptionRow<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  description,
  showLabel = true,
}: {
  label: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  description?: string;
  showLabel?: boolean;
}): React.JSX.Element {
  const descriptionId = React.useId();
  return (
    <div
      className={[
        "translate-options-row",
        disabled ? "disabled" : "",
        showLabel ? "" : "translate-options-row--unlabeled",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {showLabel ? (
        <span className="translate-options-label">{label}</span>
      ) : null}
      <SegmentedControl
        ariaLabel={label}
        ariaDescribedBy={description ? descriptionId : undefined}
        disabled={disabled}
        options={options}
        value={value}
        onChange={onChange}
      />
      {description ? (
        <p
          id={descriptionId}
          className="translate-options-selected-hint"
          aria-live="polite"
        >
          {description}
        </p>
      ) : null}
    </div>
  );
}
