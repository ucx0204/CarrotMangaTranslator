import React from "react";
import { useTranslation } from "react-i18next";
import type {
  GlossaryEntry,
  GlossaryEntryCategory,
} from "../../../../shared/workContextTypes";
import { CheckboxField } from "../ui/CheckboxField";
import { Select } from "../ui/Select";
import {
  ContextEntryDelimitedInput,
  ContextEntryDraftMarker,
  ContextEntryEnabledToggle,
  ContextEntryRowActions,
  ContextEntryUsageCount,
} from "./ContextEntryList";
import type { ContextEntryTableRowProps } from "./contextEntryTableModel";
import { CATEGORY_IDS } from "./styleGuideUtils";

export function GlossaryContextEntryRow({
  entry,
  draft = false,
  primaryInputRef,
  usage,
  selected,
  onToggleSelected,
  onUpdate,
  onRemove,
  onCompleteDraft,
  onCancelDraft,
  usageAvailable,
}: ContextEntryTableRowProps<GlossaryEntry>): React.JSX.Element {
  const { t } = useTranslation("components");
  const entryName = entry.source || entry.target;
  return (
    <div className={`style-guide-row glossary${draft ? " is-draft" : ""}`}>
      {draft ? (
        <ContextEntryDraftMarker />
      ) : (
        <CheckboxField
          className="inline-toggle"
          checked={selected}
          ariaLabel={t("styleGuide.usage.selectItem", { name: entryName })}
          onCheckedChange={onToggleSelected}
        />
      )}
      <input
        ref={primaryInputRef}
        required={draft}
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
        ariaLabel={t("styleGuide.usage.categoryItem", { name: entryName })}
        options={CATEGORY_IDS.map((id) => ({
          value: id,
          label: t(`styleGuide.glossary.categories.${id}`),
        }))}
        onValueChange={(nextValue) =>
          onUpdate({ category: nextValue as GlossaryEntryCategory })
        }
      />
      <ContextEntryDelimitedInput
        values={entry.aliases ?? []}
        placeholder={t("styleGuide.glossary.aliases")}
        onValuesChange={(aliases) => onUpdate({ aliases })}
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
      <ContextEntryRowActions
        draft={draft}
        name={entryName}
        onCompleteDraft={onCompleteDraft}
        onCancelDraft={onCancelDraft}
        onRemove={onRemove}
      />
    </div>
  );
}
