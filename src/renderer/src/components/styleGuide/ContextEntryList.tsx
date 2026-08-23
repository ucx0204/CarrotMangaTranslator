import React from "react";
import { useTranslation } from "react-i18next";
import type { WorkContextUsageMetric } from "../../../../shared/workContextUsageTypes";
import { Button } from "../ui/Button";
import { ControlTooltip } from "../ui/ControlTooltip";
import { IconButton } from "../ui/IconButton";
import { CheckCircleIcon, CloseIcon, PlusIcon, TrashIcon } from "../ui/icons";
import { Select } from "../ui/Select";
import type {
  ContextEntryFilter,
  ContextEntrySort,
  ContextEntrySortDirection,
} from "./contextEntryListModel";
import { formatContextUsage } from "./contextEntryListModel";
import { splitList } from "./styleGuideUtils";

type ContextEntryToolbarProps = {
  query: string;
  onQueryChange: (value: string) => void;
  filter: ContextEntryFilter;
  onFilterChange: (value: ContextEntryFilter) => void;
  sort: ContextEntrySort;
  onSortChange: (value: ContextEntrySort) => void;
  sortDirection: ContextEntrySortDirection;
  onSortDirectionChange: (value: ContextEntrySortDirection) => void;
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
  sortDirection: ContextEntrySortDirection;
  setSortDirection: (value: ContextEntrySortDirection) => void;
  selectedIds: ReadonlySet<string>;
  pinnedEntry?: Entry;
  visibleEntries: readonly Entry[];
};

export function ContextEntrySection<Entry>({
  children,
  emptyLabel,
  entryList,
  onDeleteSelected,
  notice,
  title,
  totalCount,
  usageAvailable,
}: {
  children: React.ReactNode;
  emptyLabel: string;
  entryList: ContextEntrySectionModel<Entry>;
  onDeleteSelected: () => void;
  notice?: string;
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
        </div>
        <ContextEntryToolbar
          query={entryList.query}
          onQueryChange={entryList.setQuery}
          filter={entryList.filter}
          onFilterChange={entryList.setFilter}
          sort={entryList.sort}
          onSortChange={entryList.setSort}
          sortDirection={entryList.sortDirection}
          onSortDirectionChange={entryList.setSortDirection}
          selectedCount={entryList.selectedIds.size}
          onDeleteSelected={onDeleteSelected}
          usageAvailable={usageAvailable}
        />
        {notice ? <p className="style-guide-list-notice">{notice}</p> : null}
        {children}
        {!entryList.pinnedEntry && entryList.visibleEntries.length === 0 ? (
          <p className="style-guide-table-empty">
            {totalCount ? t("styleGuide.usage.noMatches") : emptyLabel}
          </p>
        ) : null}
      </section>
    </div>
  );
}

export function ContextEntryAddButton({
  onClick,
}: {
  onClick: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <IconButton
      className="style-guide-row-add"
      size="sm"
      label={t("styleGuide.addRow")}
      onClick={onClick}
    >
      <PlusIcon size={15} />
    </IconButton>
  );
}

export function ContextEntryDraftMarker(): React.JSX.Element {
  return (
    <span className="style-guide-draft-marker" aria-hidden="true">
      <PlusIcon size={14} />
    </span>
  );
}

type ContextEntryDelimitedInputProps = {
  ariaLabel?: string;
  onValuesChange: (values: string[]) => void;
  placeholder: string;
  required?: boolean;
  values: readonly string[];
};

export const ContextEntryDelimitedInput = React.forwardRef<
  HTMLInputElement,
  ContextEntryDelimitedInputProps
>(function ContextEntryDelimitedInput(
  { ariaLabel, onValuesChange, placeholder, required, values },
  ref,
) {
  const formattedValue = values.join(", ");
  const [editingValue, setEditingValue] = React.useState(formattedValue);
  const editingRef = React.useRef(false);

  React.useEffect(() => {
    if (!editingRef.current) setEditingValue(formattedValue);
  }, [formattedValue]);

  return (
    <input
      ref={ref}
      aria-label={ariaLabel}
      required={required}
      value={editingValue}
      placeholder={placeholder}
      onBlur={() => {
        editingRef.current = false;
        setEditingValue(splitList(editingValue).join(", "));
      }}
      onChange={(event) => {
        const nextValue = event.target.value;
        setEditingValue(nextValue);
        onValuesChange(splitList(nextValue));
      }}
      onFocus={() => {
        editingRef.current = true;
      }}
    />
  );
});

function ContextEntryDraftActions({
  onCancel,
  onComplete,
}: {
  onCancel: () => void;
  onComplete: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="style-guide-draft-actions">
      <IconButton
        className="style-guide-draft-complete"
        size="sm"
        label={t("styleGuide.draft.complete")}
        onClick={onComplete}
      >
        <CheckCircleIcon size={15} />
      </IconButton>
      <IconButton
        size="sm"
        variant="danger"
        label={t("styleGuide.draft.cancel")}
        onClick={onCancel}
      >
        <CloseIcon size={15} />
      </IconButton>
    </div>
  );
}

export function ContextEntryRowActions({
  draft = false,
  name,
  onCancelDraft,
  onCompleteDraft,
  onRemove,
}: {
  draft?: boolean;
  name: string;
  onCancelDraft?: () => void;
  onCompleteDraft?: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  return draft && onCompleteDraft && onCancelDraft ? (
    <ContextEntryDraftActions
      onComplete={onCompleteDraft}
      onCancel={onCancelDraft}
    />
  ) : (
    <ContextEntryDeleteButton name={name} onClick={onRemove} />
  );
}

function ContextEntryToolbar({
  query,
  onQueryChange,
  filter,
  onFilterChange,
  sort,
  onSortChange,
  sortDirection,
  onSortDirectionChange,
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
        value={sortDirection}
        ariaLabel={t("styleGuide.usage.sortDirectionLabel")}
        options={(["asc", "desc"] as const).map((id) => ({
          value: id,
          label: t(`styleGuide.usage.sortDirection.${id}`),
        }))}
        onValueChange={(nextValue) =>
          onSortDirectionChange(nextValue as ContextEntrySortDirection)
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

function ContextEntryDeleteButton({
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
