import type React from "react";
import type { WorkContextUsageMetric } from "../../../../shared/workContextUsageTypes";

export type ContextEntryTableProps<Entry extends { id: string }> = {
  allVisibleSelected: boolean;
  draftEntry?: Entry;
  draftInputRef: React.RefObject<HTMLInputElement | null>;
  entries: readonly Entry[];
  onAdd: () => void;
  onCancelDraft: () => void;
  onCompleteDraft: () => void;
  onRemove: (id: string) => void;
  onToggleAll: () => void;
  onToggleSelected: (id: string) => void;
  onUpdate: (id: string, patch: Partial<Entry>) => void;
  selectedIds: ReadonlySet<string>;
  usageAvailable: boolean;
  usageById: ReadonlyMap<string, WorkContextUsageMetric>;
};

export type ContextEntryTableRowProps<Entry extends { id: string }> = {
  draft: boolean;
  entry: Entry;
  onCancelDraft?: () => void;
  onCompleteDraft?: () => void;
  onRemove: () => void;
  onToggleSelected: () => void;
  onUpdate: (patch: Partial<Entry>) => void;
  primaryInputRef?: React.Ref<HTMLInputElement>;
  selected: boolean;
  usage: WorkContextUsageMetric | undefined;
  usageAvailable: boolean;
};

export type ContextEntryTableColumn = {
  centered?: boolean;
  id: string;
  label: React.ReactNode;
};

export function createContextEntryTableProps<Entry extends { id: string }>({
  actions,
  draft,
  draftActions,
  entryList,
  usageAvailable,
}: {
  actions: {
    remove: (id: string) => void;
    update: (id: string, patch: Partial<Entry>) => void;
  };
  draft: {
    draftEntry?: Entry;
    primaryInputRef: React.RefObject<HTMLInputElement | null>;
  };
  draftActions: {
    add: () => void;
    cancel: () => void;
    complete: () => void;
  };
  entryList: {
    allVisibleSelected: boolean;
    selectedIds: ReadonlySet<string>;
    toggleAllVisible: () => void;
    toggleSelected: (id: string) => void;
    usageById: ReadonlyMap<string, WorkContextUsageMetric>;
    visibleEntries: readonly Entry[];
  };
  usageAvailable: boolean;
}): ContextEntryTableProps<Entry> {
  return {
    allVisibleSelected: entryList.allVisibleSelected,
    draftEntry: draft.draftEntry,
    draftInputRef: draft.primaryInputRef,
    entries: entryList.visibleEntries,
    onAdd: draftActions.add,
    onCancelDraft: draftActions.cancel,
    onCompleteDraft: draftActions.complete,
    onRemove: actions.remove,
    onToggleAll: entryList.toggleAllVisible,
    onToggleSelected: entryList.toggleSelected,
    onUpdate: actions.update,
    selectedIds: entryList.selectedIds,
    usageAvailable,
    usageById: entryList.usageById,
  };
}
