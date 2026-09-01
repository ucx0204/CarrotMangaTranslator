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
            tooltip: t("translationOptions.completionModeSummaries.translate"),
          },
          {
            id: "erase",
            label: t("translationOptions.completionModeErase"),
            tooltip: t("translationOptions.completionModeSummaries.erase"),
          },
        ]}
        value={eraseOriginalWorkflow ? "erase" : "translate"}
        onChange={(value) => onEraseOriginalWorkflowChange(value === "erase")}
        showLabel={false}
        tooltipPlacement="top"
      />
      <div className="translate-options-nested">
        <ToggleOptionRow
          label={t("translationOptions.bubbleLayoutWorkflow")}
          pressed={eraseOriginalWorkflow && bubbleLayoutWorkflow}
          onChange={onBubbleLayoutWorkflowChange}
          disabled={!eraseOriginalWorkflow}
          description={t(
            eraseOriginalWorkflow
              ? `translationOptions.bubbleLayoutWorkflowSummaries.${bubbleLayoutWorkflow ? "on" : "off"}`
              : "translationOptions.bubbleLayoutWorkflowSummaries.unavailable",
          )}
          tooltipPlacement="top"
        />
      </div>
    </>
  );
}

export function ToggleOptionRow({
  label,
  pressed,
  onChange,
  description,
  disabled = false,
  tooltipPlacement = "bottom",
}: {
  label: string;
  pressed: boolean;
  onChange: (pressed: boolean) => void;
  description?: string;
  disabled?: boolean;
  tooltipPlacement?: "bottom" | "top";
}): React.JSX.Element {
  const renderControl = (descriptionId?: string): React.JSX.Element => (
    <CheckboxField
      variant="switch"
      className="translate-options-switch"
      checked={pressed}
      ariaLabel={label}
      ariaDescribedBy={descriptionId}
      disabled={disabled}
      onCheckedChange={onChange}
      label={
        <span className="translate-options-switch-copy">
          <strong>{label}</strong>
        </span>
      }
    />
  );
  return description ? (
    <TranslationOptionTooltip
      content={description}
      placement={tooltipPlacement}
    >
      {renderControl}
    </TranslationOptionTooltip>
  ) : (
    renderControl()
  );
}

export function OptionRow<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  showLabel = true,
  tooltipPlacement = "bottom",
}: {
  label: string;
  options: { id: T; label: string; tooltip?: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  showLabel?: boolean;
  tooltipPlacement?: "bottom" | "top";
}): React.JSX.Element {
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
        disabled={disabled}
        options={options}
        tooltipPlacement={tooltipPlacement}
        value={value}
        onChange={onChange}
      />
    </div>
  );
}

function TranslationOptionTooltip({
  children,
  content,
  placement,
}: {
  children: (descriptionId: string) => React.ReactNode;
  content: string;
  placement: "bottom" | "top";
}): React.JSX.Element {
  const descriptionId = React.useId();
  return (
    <span
      className={`control-tooltip control-tooltip-${placement} translation-option-tooltip`}
    >
      {children(descriptionId)}
      <span
        className="control-tooltip-bubble"
        id={descriptionId}
        role="tooltip"
      >
        {content}
      </span>
    </span>
  );
}
