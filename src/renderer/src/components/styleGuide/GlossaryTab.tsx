import React from "react";
import { useTranslation } from "react-i18next";
import type {
  GlossaryEntry,
  GlossaryEntryCategory,
} from "../../../../shared/workContextTypes";
import type { WorkContextUsageMetric } from "../../../../shared/workContextUsageTypes";
import { Button } from "../ui/Button";
import { CheckboxField } from "../ui/CheckboxField";
import type { StyleGuideEditorProps } from "./styleGuideTypes";
import {
  ContextEntryDeleteButton,
  ContextEntryEnabledToggle,
  ContextEntryToolbar,
  ContextEntryUsageCount,
} from "./ContextEntryList";
import { useContextEntryList } from "./contextEntryListModel";
import {
  CATEGORY_IDS,
  makeGlossaryEntry,
  nowIso,
  splitList,
} from "./styleGuideUtils";

export function GlossaryTab({
  guide,
  onGuideChange,
  usage = [],
  usageAvailable = true,
}: StyleGuideEditorProps & {
  usage?: WorkContextUsageMetric[];
  usageAvailable?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const entryList = useContextEntryList({
    entries: guide.glossary,
    usage,
    usageAvailable,
    getName: (entry) => entry.source || entry.target,
    getSearchText: (entry) =>
      [
        entry.source,
        entry.target,
        ...(entry.aliases ?? []),
        entry.note ?? "",
      ].join(" "),
  });
  const actions = useGlossaryActions({
    guide,
    onGuideChange,
    selectedIds: entryList.selectedIds,
    clearSelection: () => entryList.setSelectedIds(new Set()),
  });
  return (
    <div className="style-guide-content">
      <section className="style-guide-section">
        <div className="style-guide-section-head">
          <h3>{t("styleGuide.tabs.glossary")}</h3>
          <Button size="sm" onClick={actions.addEntry}>
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
          onDeleteSelected={actions.removeSelected}
          usageAvailable={usageAvailable}
        />
        {entryList.visibleEntries.length ? (
          <GlossaryTable
            entries={entryList.visibleEntries}
            usageById={entryList.usageById}
            selectedIds={entryList.selectedIds}
            allVisibleSelected={entryList.allVisibleSelected}
            onToggleAll={entryList.toggleAllVisible}
            onToggleSelected={entryList.toggleSelected}
            onUpdate={actions.updateEntry}
            onRemove={actions.removeEntry}
            usageAvailable={usageAvailable}
          />
        ) : (
          <p className="style-guide-table-empty">
            {t(
              guide.glossary.length
                ? "styleGuide.usage.noMatches"
                : "styleGuide.glossary.empty",
            )}
          </p>
        )}
      </section>
    </div>
  );
}

function useGlossaryActions({
  guide,
  onGuideChange,
  selectedIds,
  clearSelection,
}: StyleGuideEditorProps & {
  selectedIds: Set<string>;
  clearSelection: () => void;
}) {
  const { t } = useTranslation("components");
  const updateEntry = (id: string, patch: Partial<GlossaryEntry>): void => {
    onGuideChange({
      ...guide,
      glossary: guide.glossary.map((entry) =>
        entry.id === id
          ? { ...entry, ...patch, origin: "manual", updatedAt: nowIso() }
          : entry,
      ),
    });
  };
  const addEntry = (): void => {
    onGuideChange({
      ...guide,
      glossary: [
        ...guide.glossary,
        makeGlossaryEntry({ source: "", target: "", category: "term" }),
      ],
    });
  };
  const removeEntry = (id: string): void => {
    onGuideChange({
      ...guide,
      glossary: guide.glossary.filter((entry) => entry.id !== id),
    });
  };
  const removeSelected = (): void => {
    const confirmed = window.confirm(
      t("styleGuide.usage.deleteConfirm", { count: selectedIds.size }),
    );
    if (!confirmed) return;
    onGuideChange({
      ...guide,
      glossary: guide.glossary.filter((entry) => !selectedIds.has(entry.id)),
    });
    clearSelection();
  };
  return { addEntry, removeEntry, removeSelected, updateEntry };
}

function GlossaryTable({
  entries,
  usageById,
  selectedIds,
  allVisibleSelected,
  onToggleAll,
  onToggleSelected,
  onUpdate,
  onRemove,
  usageAvailable,
}: {
  entries: GlossaryEntry[];
  usageById: Map<string, WorkContextUsageMetric>;
  selectedIds: Set<string>;
  allVisibleSelected: boolean;
  onToggleAll: () => void;
  onToggleSelected: (id: string) => void;
  onUpdate: (id: string, patch: Partial<GlossaryEntry>) => void;
  onRemove: (id: string) => void;
  usageAvailable: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="style-guide-table">
      <div className="style-guide-row glossary head">
        <CheckboxField
          className="inline-toggle"
          checked={allVisibleSelected}
          ariaLabel={t("styleGuide.usage.selectAll")}
          onCheckedChange={() => onToggleAll()}
        />
        <span>{t("styleGuide.glossary.source")}</span>
        <span>{t("styleGuide.glossary.translation")}</span>
        <span>{t("styleGuide.glossary.category")}</span>
        <span>{t("styleGuide.glossary.aliases")}</span>
        <span>{t("styleGuide.note")}</span>
        <span className="style-guide-centered-heading">
          {t("styleGuide.usage.count")}
        </span>
        <span className="style-guide-centered-heading">
          {t("styleGuide.usage.enabled")}
        </span>
        <span />
      </div>
      {entries.map((entry) => (
        <GlossaryRow
          key={entry.id}
          entry={entry}
          usage={usageById.get(entry.id)}
          selected={selectedIds.has(entry.id)}
          onToggleSelected={() => onToggleSelected(entry.id)}
          onUpdate={(patch) => onUpdate(entry.id, patch)}
          onRemove={() => onRemove(entry.id)}
          usageAvailable={usageAvailable}
        />
      ))}
    </div>
  );
}

type GlossaryRowProps = {
  entry: GlossaryEntry;
  usage: WorkContextUsageMetric | undefined;
  selected: boolean;
  onToggleSelected: () => void;
  onUpdate: (patch: Partial<GlossaryEntry>) => void;
  onRemove: () => void;
  usageAvailable: boolean;
};

function GlossaryRow({
  entry,
  usage,
  selected,
  onToggleSelected,
  onUpdate,
  onRemove,
  usageAvailable,
}: GlossaryRowProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const entryName = entry.source || entry.target;
  return (
    <div className="style-guide-row glossary">
      <CheckboxField
        className="inline-toggle"
        checked={selected}
        ariaLabel={t("styleGuide.usage.selectItem", { name: entryName })}
        onCheckedChange={() => onToggleSelected()}
      />
      <input
        value={entry.source}
        placeholder={t("styleGuide.glossary.source")}
        onChange={(event) => onUpdate({ source: event.target.value })}
      />
      <input
        value={entry.target}
        placeholder={t("styleGuide.glossary.translation")}
        onChange={(event) => onUpdate({ target: event.target.value })}
      />
      <select
        value={entry.category}
        aria-label={t("styleGuide.usage.categoryItem", {
          name: entryName,
        })}
        onChange={(event) =>
          onUpdate({ category: event.target.value as GlossaryEntryCategory })
        }
      >
        {CATEGORY_IDS.map((id) => (
          <option key={id} value={id}>
            {t(`styleGuide.glossary.categories.${id}`)}
          </option>
        ))}
      </select>
      <input
        value={(entry.aliases ?? []).join(", ")}
        placeholder={t("styleGuide.glossary.aliases")}
        onChange={(event) =>
          onUpdate({ aliases: splitList(event.target.value) })
        }
      />
      <input
        value={entry.note ?? ""}
        placeholder={t("styleGuide.note")}
        onChange={(event) => onUpdate({ note: event.target.value })}
      />
      <ContextEntryUsageCount metric={usage} usageAvailable={usageAvailable} />
      <ContextEntryEnabledToggle
        enabled={entry.enabled}
        name={entryName}
        onChange={(enabled) => onUpdate({ enabled })}
      />
      <ContextEntryDeleteButton name={entryName} onClick={onRemove} />
    </div>
  );
}
