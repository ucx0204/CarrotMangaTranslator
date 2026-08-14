import React from "react";
import { useTranslation } from "react-i18next";
import type {
  GlossaryEntry,
  GlossaryEntryCategory,
} from "../../../../shared/workContextTypes";
import type { WorkContextUsageMetric } from "../../../../shared/workContextUsageTypes";
import { CheckboxField } from "../ui/CheckboxField";
import { Select } from "../ui/Select";
import type { StyleGuideEditorProps } from "./styleGuideTypes";
import {
  ContextEntryDeleteButton,
  ContextEntryEnabledToggle,
  ContextEntrySection,
  ContextEntryUsageCount,
} from "./ContextEntryList";
import { createContextEntryActions } from "./contextEntryActions";
import { useContextEntryList } from "./contextEntryListModel";
import { CATEGORY_IDS, makeGlossaryEntry, splitList } from "./styleGuideUtils";

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
    <ContextEntrySection
      emptyLabel={t("styleGuide.glossary.empty")}
      entryList={entryList}
      title={t("styleGuide.tabs.glossary")}
      totalCount={guide.glossary.length}
      usageAvailable={usageAvailable}
      onAdd={actions.add}
      onDeleteSelected={actions.removeSelected}
    >
      <GlossaryTable
        entries={entryList.visibleEntries}
        usageById={entryList.usageById}
        selectedIds={entryList.selectedIds}
        allVisibleSelected={entryList.allVisibleSelected}
        onToggleAll={entryList.toggleAllVisible}
        onToggleSelected={entryList.toggleSelected}
        onUpdate={actions.update}
        onRemove={actions.remove}
        usageAvailable={usageAvailable}
      />
    </ContextEntrySection>
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
  return createContextEntryActions({
    entries: guide.glossary,
    selectedIds,
    clearSelection,
    createEntry: () =>
      makeGlossaryEntry({ source: "", target: "", category: "term" }),
    confirmDelete: (count) =>
      window.confirm(t("styleGuide.usage.deleteConfirm", { count })),
    onEntriesChange: (glossary) => onGuideChange({ ...guide, glossary }),
  });
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
      <Select
        value={entry.category}
        ariaLabel={t("styleGuide.usage.categoryItem", {
          name: entryName,
        })}
        options={CATEGORY_IDS.map((id) => ({
          value: id,
          label: t(`styleGuide.glossary.categories.${id}`),
        }))}
        onValueChange={(nextValue) =>
          onUpdate({ category: nextValue as GlossaryEntryCategory })
        }
      />
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
