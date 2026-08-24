import React from "react";
import { useTranslation } from "react-i18next";
import type { GatherField, GatherScope } from "../../lib/gatherText";
import { Button } from "../ui/Button";
import { SegmentedControl } from "../ui/SegmentedControl";

export function GatherTextControls({
  scope,
  field,
  multiSelectAvailable,
  selectionMode,
  onScopeChange,
  onFieldChange,
  onEnterSelectionMode,
}: {
  scope: GatherScope;
  field: GatherField;
  multiSelectAvailable: boolean;
  selectionMode: boolean;
  onScopeChange: (scope: GatherScope) => void;
  onFieldChange: (field: GatherField) => void;
  onEnterSelectionMode: () => void;
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
      {multiSelectAvailable && !selectionMode ? (
        <Button
          size="sm"
          variant="ghost"
          className="gather-text-multi-select-button"
          onClick={onEnterSelectionMode}
        >
          {t("gatherText.enterSelectionMode")}
        </Button>
      ) : null}
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
      <SegmentedControl
        ariaLabel={label}
        singleRow
        options={options}
        value={value}
        onChange={onChange}
      />
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
