import { nowIso } from "./styleGuideUtils";

type EditableContextEntry = {
  id: string;
  origin?: "ai" | "manual";
  updatedAt: string;
};

export function createContextEntryActions<Entry extends EditableContextEntry>({
  clearSelection,
  confirmDelete,
  createEntry,
  entries,
  onEntriesChange,
  selectedIds,
}: {
  clearSelection: () => void;
  confirmDelete: (count: number) => boolean;
  createEntry: () => Entry;
  entries: readonly Entry[];
  onEntriesChange: (entries: Entry[]) => void;
  selectedIds: ReadonlySet<string>;
}) {
  const update = (id: string, patch: Partial<Entry>): void => {
    onEntriesChange(
      entries.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              ...patch,
              origin: "manual",
              updatedAt: nowIso(),
            }
          : entry,
      ),
    );
  };
  const add = (): Entry => {
    const entry = createEntry();
    onEntriesChange([...entries, entry]);
    return entry;
  };
  const remove = (id: string): void =>
    onEntriesChange(entries.filter((entry) => entry.id !== id));
  const removeSelected = (): void => {
    if (!confirmDelete(selectedIds.size)) return;
    onEntriesChange(entries.filter((entry) => !selectedIds.has(entry.id)));
    clearSelection();
  };
  return { add, remove, removeSelected, update };
}
