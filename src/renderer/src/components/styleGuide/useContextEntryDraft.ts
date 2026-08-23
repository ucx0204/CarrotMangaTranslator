import React from "react";

type DraftEntryBase = { id: string };

export function useContextEntryDraft<TEntry extends DraftEntryBase>({
  entries,
  isComplete,
  draftId: controlledDraftId,
  onDraftIdChange,
}: {
  entries: readonly TEntry[];
  isComplete: (entry: TEntry) => boolean;
  draftId?: string | null;
  onDraftIdChange?: (id: string | null) => void;
}) {
  const [localDraftId, setLocalDraftId] = React.useState<string | null>(null);
  const [focusRequest, setFocusRequest] = React.useState(0);
  const primaryInputRef = React.useRef<HTMLInputElement>(null);
  const draftId =
    controlledDraftId === undefined ? localDraftId : controlledDraftId;
  const draftEntry = entries.find((entry) => entry.id === draftId);
  const draftIdRef = React.useRef<string | null>(draftId);
  const draftEntryRef = React.useRef<TEntry | undefined>(draftEntry);
  React.useLayoutEffect(() => {
    draftIdRef.current = draftId;
    draftEntryRef.current = draftEntry;
  }, [draftEntry, draftId]);
  const setDraftId = React.useCallback(
    (id: string | null): void => {
      draftIdRef.current = id;
      if (controlledDraftId === undefined) setLocalDraftId(id);
      onDraftIdChange?.(id);
    },
    [controlledDraftId, onDraftIdChange],
  );

  React.useEffect(() => {
    if (draftId && !draftEntry && draftIdRef.current === draftId) {
      draftEntryRef.current = undefined;
      setDraftId(null);
    }
  }, [draftEntry, draftId, setDraftId]);

  React.useLayoutEffect(() => {
    if (!draftEntry?.id) return;
    const input = primaryInputRef.current;
    const row = input?.closest(".style-guide-row") ?? input;
    if (row && "scrollIntoView" in row) {
      row.scrollIntoView({ block: "start", inline: "nearest" });
    }
    input?.focus();
  }, [draftEntry?.id, focusRequest]);

  const focus = (): void => setFocusRequest((value) => value + 1);
  const begin = (entry: TEntry): void => {
    draftEntryRef.current = entry;
    setDraftId(entry.id);
    setFocusRequest((value) => value + 1);
  };
  const complete = (latestDraft?: TEntry): void => {
    const currentDraft = latestDraft ?? draftEntryRef.current;
    if (!currentDraft) return;
    if (!isComplete(currentDraft)) {
      primaryInputRef.current?.reportValidity();
      primaryInputRef.current?.focus();
      return;
    }
    draftEntryRef.current = undefined;
    setDraftId(null);
  };
  const cancel = (): void => {
    if (!draftEntryRef.current) return;
    draftEntryRef.current = undefined;
    setDraftId(null);
  };
  const getCurrentEntry = (): TEntry | undefined => draftEntryRef.current;

  return {
    begin,
    cancel,
    complete,
    draftEntry,
    draftId,
    focus,
    getCurrentEntry,
    primaryInputRef,
  };
}
