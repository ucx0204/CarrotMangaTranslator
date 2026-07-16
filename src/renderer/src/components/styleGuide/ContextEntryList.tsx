import React from "react";
import { useTranslation } from "react-i18next";
import type { WorkContextUsageMetric } from "../../../../shared/workContextUsageTypes";
import { Button } from "../ui/Button";
import { ControlTooltip } from "../ui/ControlTooltip";
import { IconButton } from "../ui/IconButton";
import { TrashIcon } from "../ui/icons";
import type {
  ContextEntryFilter,
  ContextEntrySort,
} from "./contextEntryListModel";
import { formatContextUsage } from "./contextEntryListModel";

type ContextEntryToolbarProps = {
  query: string;
  onQueryChange: (value: string) => void;
  filter: ContextEntryFilter;
  onFilterChange: (value: ContextEntryFilter) => void;
  sort: ContextEntrySort;
  onSortChange: (value: ContextEntrySort) => void;
  selectedCount: number;
  onDeleteSelected: () => void;
  usageAvailable?: boolean;
};

export function ContextEntryToolbar({
  query,
  onQueryChange,
  filter,
  onFilterChange,
  sort,
  onSortChange,
  selectedCount,
  onDeleteSelected,
  usageAvailable = true,
}: ContextEntryToolbarProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="style-guide-list-toolbar">
      <input
        type="search"
        value={query}
        aria-label={t("styleGuide.usage.search")}
        placeholder={t("styleGuide.usage.search")}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      <select
        value={sort}
        aria-label={t("styleGuide.usage.sortLabel")}
        onChange={(event) =>
          onSortChange(event.target.value as ContextEntrySort)
        }
      >
        {(["usage", "recent", "name", "stored"] as const).map((id) => (
          <option
            key={id}
            value={id}
            disabled={!usageAvailable && (id === "usage" || id === "recent")}
          >
            {t(`styleGuide.usage.sort.${id}`)}
          </option>
        ))}
      </select>
      <select
        value={filter}
        aria-label={t("styleGuide.usage.filterLabel")}
        onChange={(event) =>
          onFilterChange(event.target.value as ContextEntryFilter)
        }
      >
        {(["all", "ai", "unused", "low-use", "disabled"] as const).map((id) => (
          <option
            key={id}
            value={id}
            disabled={!usageAvailable && (id === "unused" || id === "low-use")}
          >
            {t(`styleGuide.usage.filter.${id}`)}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="danger"
        disabled={selectedCount === 0}
        onClick={onDeleteSelected}
      >
        {t("styleGuide.usage.deleteSelected", { count: selectedCount })}
      </Button>
      {!usageAvailable ? (
        <span className="style-guide-usage-unavailable" role="status">
          {t("styleGuide.usage.unavailable")}
        </span>
      ) : null}
    </div>
  );
}

export function ContextEntryUsageCount({
  metric,
  usageAvailable,
}: {
  metric: WorkContextUsageMetric | undefined;
  usageAvailable: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const detail = formatContextUsage(
    metric,
    (key, values) => t(key, values),
    usageAvailable,
  );
  return (
    <div className="style-guide-usage-count">
      <ControlTooltip content={detail} placement="left">
        <span className="style-guide-usage-number" tabIndex={0}>
          {usageAvailable ? (metric?.mentionCount ?? 0) : "—"}
        </span>
      </ControlTooltip>
    </div>
  );
}

export function ContextEntryEnabledToggle({
  enabled,
  name,
  onChange,
}: {
  enabled: boolean;
  name: string;
  onChange: (enabled: boolean) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <button
      type="button"
      className="style-guide-enabled-toggle"
      role="switch"
      aria-checked={enabled}
      aria-label={t("styleGuide.usage.enabledItem", { name })}
      onClick={() => onChange(!enabled)}
    >
      <span aria-hidden="true" />
    </button>
  );
}

export function ContextEntryDeleteButton({
  name,
  onClick,
}: {
  name: string;
  onClick: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <IconButton
      className="style-guide-row-delete"
      size="sm"
      variant="danger"
      label={t("styleGuide.usage.deleteItem", { name })}
      onClick={onClick}
    >
      <TrashIcon size={15} />
    </IconButton>
  );
}
