import React from "react";
import { useTranslation } from "react-i18next";
import type { GatherField, GatherScope } from "../../lib/gatherText";

export function GatherTextControls({
  scope,
  field,
  onScopeChange,
  onFieldChange,
}: {
  scope: GatherScope;
  field: GatherField;
  onScopeChange: (scope: GatherScope) => void;
  onFieldChange: (field: GatherField) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="gather-text-controls">
      <SegmentedRow
        label={t("gatherText.scope")}
        options={[
          { id: "page", label: t("common.thisPage") },
          { id: "chapter", label: t("gatherText.entireChapter") },
        ]}
        value={scope}
        onChange={onScopeChange}
      />
      <SegmentedRow
        label={t("gatherText.display")}
        options={[
          { id: "both", label: t("gatherText.fields.both") },
          { id: "translated", label: t("gatherText.fields.translated") },
          { id: "source", label: t("gatherText.fields.source") },
        ]}
        value={field}
        onChange={onFieldChange}
      />
    </div>
  );
}

function SegmentedRow<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}): React.JSX.Element {
  return (
    <div className="gather-text-control">
      <span>{label}</span>
      <div className="settings-mode-group" role="tablist" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`settings-preset-button ${value === option.id ? "active" : ""}`}
            aria-pressed={value === option.id}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ReviewWarnings({
  warnings,
}: {
  warnings: string[];
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (!warnings.length) return null;
  return (
    <details className="gather-review-warnings">
      <summary>
        {t("gatherText.reviewWarnings", { count: warnings.length })}
      </summary>
      <ul>
        {warnings.slice(0, 80).map((warning, index) => (
          <li key={`${warning}-${index}`}>{warning}</li>
        ))}
      </ul>
    </details>
  );
}
