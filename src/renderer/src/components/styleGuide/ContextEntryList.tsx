import React from "react";
import { useTranslation } from "react-i18next";
import type { WorkContextUsageMetric } from "../../../../shared/workContextUsageTypes";
import { Button } from "../ui/Button";
import { ControlTooltip } from "../ui/ControlTooltip";
import { IconButton } from "../ui/IconButton";
import { TrashIcon } from "../ui/icons";
import { Select } from "../ui/Select";
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

type ContextEntrySectionModel<Entry> = {
  query: string;
  setQuery: (value: string) => void;
  filter: ContextEntryFilter;
  setFilter: (value: ContextEntryFilter) => void;
  sort: ContextEntrySort;
  setSort: (value: ContextEntrySort) => void;
  selectedIds: ReadonlySet<string>;
  visibleEntries: readonly Entry[];
};

export function ContextEntrySection<Entry>({
  children,
  emptyLabel,
  entryList,
  onAdd,
  onDeleteSelected,
  title,
  totalCount,
  usageAvailable,
}: {
  children: React.ReactNode;
  emptyLabel: string;
  entryList: ContextEntrySectionModel<Entry>;
  onAdd: () => void;
  onDeleteSelected: () => void;
  title: string;
  totalCount: number;
  usageAvailable: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="style-guide-content">
      <section className="style-guide-section">
        <div className="style-guide-section-head">
          <h3>{title}</h3>
          <Button size="sm" onClick={onAdd}>
            {t("styleGuide.addRow")}
          </Button>
        </div>
        <ContextEntryToolbar
          query={entryList.query}
          onQueryChange={entryList.setQuery}
          filter={entryList.filter}
          onFilterChange={entryList.setFilter}
          sort={entryList.sort}
          onSortChange={entryList.setSort}
          selectedCount={entryList.selectedIds.size}
          onDeleteSelected={onDeleteSelected}
          usageAvailable={usageAvailable}
        />
        {entryList.visibleEntries.length ? (
          children
        ) : (
          <p className="style-guide-table-empty">
            {totalCount ? t("styleGuide.usage.noMatches") : emptyLabel}
          </p>
        )}
      </section>
    </div>
  );
}

function ContextEntryToolbar({
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
      <Select
        value={sort}
        ariaLabel={t("styleGuide.usage.sortLabel")}
        options={(["usage", "recent", "name", "stored"] as const).map((id) => ({
          value: id,
          label: t(`styleGuide.usage.sort.${id}`),
          disabled: !usageAvailable && (id === "usage" || id === "recent"),
        }))}
        onValueChange={(nextValue) =>
          onSortChange(nextValue as ContextEntrySort)
        }
      />
      <Select
        value={filter}
        ariaLabel={t("styleGuide.usage.filterLabel")}
        options={(["all", "ai", "unused", "low-use", "disabled"] as const).map(
          (id) => ({
            value: id,
            label: t(`styleGuide.usage.filter.${id}`),
            disabled: !usageAvailable && (id === "unused" || id === "low-use"),
          }),
        )}
        onValueChange={(nextValue) =>
          onFilterChange(nextValue as ContextEntryFilter)
        }
      />
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
