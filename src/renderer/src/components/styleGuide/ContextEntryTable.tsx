import React from "react";
import { useTranslation } from "react-i18next";
import { CheckboxField } from "../ui/CheckboxField";
import { ContextEntryAddButton } from "./ContextEntryList";
import type {
  ContextEntryTableColumn,
  ContextEntryTableProps,
  ContextEntryTableRowProps,
} from "./contextEntryTableModel";

export function ContextEntryTable<Entry extends { id: string }>({
  columns,
  renderRow,
  rowClassName,
  ...tableProps
}: ContextEntryTableProps<Entry> & {
  columns: readonly ContextEntryTableColumn[];
  renderRow: (props: ContextEntryTableRowProps<Entry>) => React.ReactNode;
  rowClassName: string;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="style-guide-table">
      <div className={`style-guide-row ${rowClassName} head`}>
        <CheckboxField
          className="inline-toggle"
          checked={tableProps.allVisibleSelected}
          ariaLabel={t("styleGuide.usage.selectAll")}
          onCheckedChange={tableProps.onToggleAll}
        />
        {columns.map((column) => (
          <span
            key={column.id}
            className={
              column.centered ? "style-guide-centered-heading" : undefined
            }
          >
            {column.label}
          </span>
        ))}
        <ContextEntryAddButton onClick={tableProps.onAdd} />
      </div>
      <ContextEntryTableRows {...tableProps} renderRow={renderRow} />
    </div>
  );
}

function ContextEntryTableRows<Entry extends { id: string }>({
  draftEntry,
  draftInputRef,
  entries,
  onCancelDraft,
  onCompleteDraft,
  onRemove,
  onToggleSelected,
  onUpdate,
  renderRow,
  selectedIds,
  usageAvailable,
  usageById,
}: Omit<
  ContextEntryTableProps<Entry>,
  "allVisibleSelected" | "onAdd" | "onToggleAll"
> & {
  renderRow: (props: ContextEntryTableRowProps<Entry>) => React.ReactNode;
}): React.JSX.Element {
  return (
    <>
      {draftEntry ? (
        <React.Fragment key={draftEntry.id}>
          {renderRow({
            draft: true,
            entry: draftEntry,
            onCancelDraft,
            onCompleteDraft,
            onRemove: () => onRemove(draftEntry.id),
            onToggleSelected: () => undefined,
            onUpdate: (patch) => onUpdate(draftEntry.id, patch),
            primaryInputRef: draftInputRef,
            selected: false,
            usage: undefined,
            usageAvailable,
          })}
        </React.Fragment>
      ) : null}
      {entries.map((entry) => (
        <React.Fragment key={entry.id}>
          {renderRow({
            draft: false,
            entry,
            onRemove: () => onRemove(entry.id),
            onToggleSelected: () => onToggleSelected(entry.id),
            onUpdate: (patch) => onUpdate(entry.id, patch),
            selected: selectedIds.has(entry.id),
            usage: usageById.get(entry.id),
            usageAvailable,
          })}
        </React.Fragment>
      ))}
    </>
  );
}
