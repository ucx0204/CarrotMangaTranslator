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
  confirmDelete: (count: number) => boolean | Promise<boolean>;
  createEntry: () => Entry;
  entries: readonly Entry[];
  onEntriesChange: (entries: Entry[]) => void;
  selectedIds: ReadonlySet<string>;
}) {
  // React may batch several input/click events before the parent renders again.
  // Keep the newest list inside this action set so a quick delete -> add or two
  // adjacent edits cannot rebuild the next value from an older render snapshot.
  let latestEntries = entries;
  const changeEntries = (
    update: (current: readonly Entry[]) => Entry[],
  ): Entry[] => {
    const nextEntries = update(latestEntries);
    latestEntries = nextEntries;
    onEntriesChange(nextEntries);
    return nextEntries;
  };
  const update = (id: string, patch: Partial<Entry>): void => {
    changeEntries((current) =>
      current.map((entry) =>
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
    changeEntries((current) => [...current, entry]);
    return entry;
  };
  const remove = (id: string): void =>
    void changeEntries((current) => current.filter((entry) => entry.id !== id));
  const removeSelected = async (): Promise<void> => {
    const idsToRemove = new Set(selectedIds);
    if (idsToRemove.size === 0 || !(await confirmDelete(idsToRemove.size))) {
      return;
    }
    changeEntries((current) =>
      current.filter((entry) => !idsToRemove.has(entry.id)),
    );
    clearSelection();
  };
  const get = (id: string): Entry | undefined =>
    latestEntries.find((entry) => entry.id === id);
  return { add, get, remove, removeSelected, update };
}

export function createContextEntryDraftActions<
  Entry extends EditableContextEntry,
>({
  actions,
  draft,
}: {
  actions: Pick<
    ReturnType<typeof createContextEntryActions<Entry>>,
    "add" | "get" | "remove"
  >;
  draft: {
    begin: (entry: Entry) => void;
    cancel: () => void;
    complete: (entry?: Entry) => void;
    focus: () => void;
    getCurrentEntry: () => Entry | undefined;
  };
}): { add: () => void; cancel: () => void; complete: () => void } {
  const add = (): void =>
    draft.getCurrentEntry() ? draft.focus() : draft.begin(actions.add());
  const cancel = (): void => {
    const current = draft.getCurrentEntry();
    if (current) actions.remove(current.id);
    draft.cancel();
  };
  const complete = (): void => {
    const current = draft.getCurrentEntry();
    draft.complete(current ? actions.get(current.id) : undefined);
  };
  return { add, cancel, complete };
}
