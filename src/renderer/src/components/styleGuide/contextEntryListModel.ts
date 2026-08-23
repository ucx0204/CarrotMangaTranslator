import React from "react";
import type { WorkContextUsageMetric } from "../../../../shared/workContextUsageTypes";

export type ContextEntryFilter =
  | "all"
  | "ai"
  | "unused"
  | "low-use"
  | "disabled";
export type ContextEntrySort = "usage" | "recent" | "name" | "stored";
export type ContextEntrySortDirection = "asc" | "desc";

type ContextEntryBase = {
  id: string;
  enabled: boolean;
  origin?: "ai" | "manual";
};

type ContextEntryListOptions<TEntry extends ContextEntryBase> = {
  entries: TEntry[];
  usage: WorkContextUsageMetric[];
  usageAvailable?: boolean;
  getName: (entry: TEntry) => string;
  getSearchText: (entry: TEntry) => string;
  pinnedEntryId?: string | null;
};

export function useContextEntryList<TEntry extends ContextEntryBase>({
  entries,
  usage,
  usageAvailable = true,
  getName,
  getSearchText,
  pinnedEntryId = null,
}: ContextEntryListOptions<TEntry>) {
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<ContextEntryFilter>("all");
  const [sort, setSortState] = React.useState<ContextEntrySort>("usage");
  const [sortDirection, setSortDirection] =
    React.useState<ContextEntrySortDirection>("desc");
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  const usageById = React.useMemo(
    () => new Map(usage.map((metric) => [metric.id, metric])),
    [usage],
  );
  const { pinnedEntry, visibleEntries } = useVisibleContextEntries({
    entries,
    filter,
    getName,
    getSearchText,
    pinnedEntryId,
    query,
    sort,
    sortDirection,
    usageById,
  });
  usePruneSelection(entries, setSelectedIds);
  useContextEntryListEffects({
    filter,
    query,
    setFilter,
    setSelectedIds,
    setSortDirection,
    setSortState,
    usageAvailable,
  });

  const setSort = React.useCallback((nextSort: ContextEntrySort): void => {
    setSortState(nextSort);
    setSortDirection(defaultSortDirection(nextSort));
  }, []);

  const toggleSelected = (id: string): void => {
    setSelectedIds((current) => toggleSetValue(current, id));
  };
  const allVisibleSelected =
    visibleEntries.length > 0 &&
    visibleEntries.every((entry) => selectedIds.has(entry.id));
  const toggleAllVisible = (): void => {
    setSelectedIds((current) =>
      updateVisibleSelection(current, visibleEntries, allVisibleSelected),
    );
  };
  return {
    query,
    setQuery,
    filter,
    setFilter,
    sort,
    setSort,
    sortDirection,
    setSortDirection,
    selectedIds,
    setSelectedIds,
    toggleSelected,
    pinnedEntry,
    visibleEntries,
    usageById,
    allVisibleSelected,
    toggleAllVisible,
  };
}

function useVisibleContextEntries<TEntry extends ContextEntryBase>({
  entries,
  filter,
  getName,
  getSearchText,
  pinnedEntryId,
  query,
  sort,
  sortDirection,
  usageById,
}: Omit<ContextEntryListOptions<TEntry>, "usage" | "usageAvailable"> & {
  filter: ContextEntryFilter;
  query: string;
  sort: ContextEntrySort;
  sortDirection: ContextEntrySortDirection;
  usageById: Map<string, WorkContextUsageMetric>;
}): { pinnedEntry: TEntry | undefined; visibleEntries: TEntry[] } {
  const pinnedEntry = React.useMemo(
    () => entries.find((entry) => entry.id === pinnedEntryId),
    [entries, pinnedEntryId],
  );
  const visibleEntries = React.useMemo(
    () =>
      filterAndSortEntries({
        entries: pinnedEntryId
          ? entries.filter((entry) => entry.id !== pinnedEntryId)
          : entries,
        filter,
        getName,
        getSearchText,
        query,
        sort,
        sortDirection,
        usageById,
      }),
    [
      entries,
      filter,
      getName,
      getSearchText,
      pinnedEntryId,
      query,
      sort,
      sortDirection,
      usageById,
    ],
  );
  return { pinnedEntry, visibleEntries };
}

function useContextEntryListEffects({
  filter,
  query,
  setFilter,
  setSelectedIds,
  setSortDirection,
  setSortState,
  usageAvailable,
}: {
  filter: ContextEntryFilter;
  query: string;
  setFilter: React.Dispatch<React.SetStateAction<ContextEntryFilter>>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setSortDirection: React.Dispatch<
    React.SetStateAction<ContextEntrySortDirection>
  >;
  setSortState: React.Dispatch<React.SetStateAction<ContextEntrySort>>;
  usageAvailable: boolean;
}): void {
  React.useEffect(
    () => setSelectedIds(new Set()),
    [filter, query, setSelectedIds],
  );
  React.useEffect(() => {
    if (usageAvailable) return;
    setFilter((current) =>
      current === "unused" || current === "low-use" ? "all" : current,
    );
    setSortState((current) => {
      if (current !== "usage" && current !== "recent") return current;
      setSortDirection(defaultSortDirection("stored"));
      return "stored";
    });
  }, [setFilter, setSortDirection, setSortState, usageAvailable]);
}

function filterAndSortEntries<TEntry extends ContextEntryBase>({
  entries,
  filter,
  getName,
  getSearchText,
  query,
  sort,
  sortDirection,
  usageById,
}: {
  entries: TEntry[];
  filter: ContextEntryFilter;
  getName: (entry: TEntry) => string;
  getSearchText: (entry: TEntry) => string;
  query: string;
  sort: ContextEntrySort;
  sortDirection: ContextEntrySortDirection;
  usageById: Map<string, WorkContextUsageMetric>;
}): TEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const storedIndex = new Map(entries.map((entry, index) => [entry.id, index]));
  return entries
    .filter(
      (entry) =>
        matchesFilter(entry, filter, usageById.get(entry.id)) &&
        matchesQuery(entry, normalizedQuery, getSearchText),
    )
    .slice()
    .sort((left, right) =>
      compareEntries(
        left,
        right,
        sort,
        sortDirection,
        usageById,
        storedIndex,
        getName,
      ),
    );
}

function matchesFilter(
  entry: ContextEntryBase,
  filter: ContextEntryFilter,
  metric: WorkContextUsageMetric | undefined,
): boolean {
  if (filter === "ai") return entry.origin === "ai";
  if (filter === "unused") return (metric?.pageCount ?? 0) === 0;
  if (filter === "low-use") return (metric?.pageCount ?? 0) <= 1;
  if (filter === "disabled") return !entry.enabled;
  return true;
}

function matchesQuery<TEntry>(
  entry: TEntry,
  query: string,
  getSearchText: (entry: TEntry) => string,
): boolean {
  return !query || getSearchText(entry).toLocaleLowerCase().includes(query);
}

function compareEntries<TEntry extends ContextEntryBase>(
  left: TEntry,
  right: TEntry,
  sort: ContextEntrySort,
  sortDirection: ContextEntrySortDirection,
  usageById: Map<string, WorkContextUsageMetric>,
  storedIndex: Map<string, number>,
  getName: (entry: TEntry) => string,
): number {
  const leftMetric = usageById.get(left.id);
  const rightMetric = usageById.get(right.id);
  const direction = sortDirection === "asc" ? 1 : -1;
  if (sort === "usage") {
    return (
      compareUsage(leftMetric, rightMetric) * direction ||
      compareNames(left, right)
    );
  }
  if (sort === "recent") {
    return (
      compareLastSeen(leftMetric, rightMetric) * direction ||
      compareNames(left, right)
    );
  }
  if (sort === "name") return compareNames(left, right) * direction;
  return (
    ((storedIndex.get(left.id) ?? 0) - (storedIndex.get(right.id) ?? 0)) *
    direction
  );

  function compareNames(first: TEntry, second: TEntry): number {
    return getName(first).localeCompare(getName(second));
  }
}

function defaultSortDirection(
  sort: ContextEntrySort,
): ContextEntrySortDirection {
  return sort === "usage" || sort === "recent" ? "desc" : "asc";
}

function compareUsage(
  left: WorkContextUsageMetric | undefined,
  right: WorkContextUsageMetric | undefined,
): number {
  return (
    (left?.pageCount ?? 0) - (right?.pageCount ?? 0) ||
    (left?.mentionCount ?? 0) - (right?.mentionCount ?? 0)
  );
}

function compareLastSeen(
  left: WorkContextUsageMetric | undefined,
  right: WorkContextUsageMetric | undefined,
): number {
  const leftSeen = left?.lastSeen;
  const rightSeen = right?.lastSeen;
  if (!leftSeen && !rightSeen) return 0;
  if (!leftSeen) return -1;
  if (!rightSeen) return 1;
  return (
    leftSeen.chapterIndex - rightSeen.chapterIndex ||
    leftSeen.pageIndex - rightSeen.pageIndex
  );
}

function usePruneSelection<TEntry extends ContextEntryBase>(
  entries: TEntry[],
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>,
): void {
  React.useEffect(() => {
    const liveIds = new Set(entries.map((entry) => entry.id));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => liveIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [entries, setSelectedIds]);
}

function toggleSetValue(current: Set<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function updateVisibleSelection<TEntry extends ContextEntryBase>(
  current: Set<string>,
  visibleEntries: TEntry[],
  remove: boolean,
): Set<string> {
  const next = new Set(current);
  visibleEntries.forEach((entry) => {
    if (remove) next.delete(entry.id);
    else next.add(entry.id);
  });
  return next;
}

export function formatContextUsage(
  metric: WorkContextUsageMetric | undefined,
  format: (key: string, values?: Record<string, unknown>) => string,
  usageAvailable = true,
): string {
  if (!usageAvailable) return format("styleGuide.usage.unavailable");
  if (!metric) return format("styleGuide.usage.neverUsed");
  if (!metric.lastSeen) {
    return format("styleGuide.usage.summaryNoRecent", {
      pages: metric.pageCount,
      mentions: metric.mentionCount,
    });
  }
  return format("styleGuide.usage.summary", {
    pages: metric.pageCount,
    mentions: metric.mentionCount,
    chapter: metric.lastSeen.chapterTitle,
    page: metric.lastSeen.pageIndex + 1,
  });
}
