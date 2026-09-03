import React from "react";
import type {
  TextStylePatch,
  TextStyleRun,
} from "../../../shared/richTextMarkup";
import {
  getRichTextEditorCaretRun,
  type RichTextEditorSelection,
} from "../lib/richTextEditorDom";

export type RichTranslationSelectionState = {
  beforeInputRef: React.MutableRefObject<{
    selection: RichTextEditorSelection;
    style: TextStylePatch | null;
  } | null>;
  caretRun: TextStyleRun | null;
  clearTypingStyle: () => void;
  compositionBeforeInputRef: React.MutableRefObject<{
    selection: RichTextEditorSelection;
    style: TextStylePatch | null;
  } | null>;
  compositionCommitTimerRef: React.MutableRefObject<number | null>;
  compositionEndPendingRef: React.MutableRefObject<boolean>;
  composingRef: React.MutableRefObject<boolean>;
  recordVisualSelection: (
    root: HTMLElement,
    selection: RichTextEditorSelection,
  ) => void;
  selection: RichTextEditorSelection;
  selectionRef: React.MutableRefObject<RichTextEditorSelection>;
  setCaretRun: React.Dispatch<React.SetStateAction<TextStyleRun | null>>;
  setSelection: (selection: RichTextEditorSelection) => void;
  typingOffsetRef: React.MutableRefObject<number | null>;
  typingStyle: TextStylePatch | null;
  typingStyleRef: React.MutableRefObject<TextStylePatch | null>;
  updateTypingStyle: (patch: TextStylePatch) => void;
};

export function useRichTranslationEditorState(
  blockId: string,
): RichTranslationSelectionState {
  const [selection, setSelectionState] =
    React.useState<RichTextEditorSelection>({ start: 0, end: 0 });
  const selectionRef = React.useRef(selection);
  const [caretRun, setCaretRun] = React.useState<TextStyleRun | null>(null);
  const [typingStyle, setTypingStyleState] =
    React.useState<TextStylePatch | null>(null);
  const typingStyleRef = React.useRef<TextStylePatch | null>(null);
  const typingOffsetRef = React.useRef<number | null>(null);
  const beforeInputRef = React.useRef<{
    selection: RichTextEditorSelection;
    style: TextStylePatch | null;
  } | null>(null);
  const composingRef = React.useRef(false);
  const compositionBeforeInputRef = React.useRef<{
    selection: RichTextEditorSelection;
    style: TextStylePatch | null;
  } | null>(null);
  const compositionEndPendingRef = React.useRef(false);
  const compositionCommitTimerRef = React.useRef<number | null>(null);
  const setSelection = React.useCallback((next: RichTextEditorSelection) => {
    selectionRef.current = next;
    setSelectionState(next);
  }, []);
  const clearTypingStyle = React.useCallback(() => {
    typingStyleRef.current = null;
    typingOffsetRef.current = null;
    setTypingStyleState(null);
  }, []);
  const updateTypingStyle = React.useCallback((patch: TextStylePatch) => {
    const next = { ...(typingStyleRef.current ?? {}), ...patch };
    typingStyleRef.current = next;
    typingOffsetRef.current = selectionRef.current.start;
    setTypingStyleState(next);
  }, []);
  const recordVisualSelection = useRecordVisualSelection({
    beforeInputRef,
    caretRunSetter: setCaretRun,
    clearTypingStyle,
    composingRef,
    setSelection,
    typingOffsetRef,
    typingStyleRef,
  });
  useResetRichTranslationState({
    beforeInputRef,
    blockId,
    clearTypingStyle,
    compositionBeforeInputRef,
    compositionCommitTimerRef,
    compositionEndPendingRef,
    composingRef,
  });
  return {
    beforeInputRef,
    caretRun,
    clearTypingStyle,
    compositionBeforeInputRef,
    compositionCommitTimerRef,
    compositionEndPendingRef,
    composingRef,
    recordVisualSelection,
    selection,
    selectionRef,
    setCaretRun,
    setSelection,
    typingOffsetRef,
    typingStyle,
    typingStyleRef,
    updateTypingStyle,
  };
}

type RecordSelectionArgs = Pick<
  RichTranslationSelectionState,
  | "beforeInputRef"
  | "clearTypingStyle"
  | "composingRef"
  | "setSelection"
  | "typingOffsetRef"
  | "typingStyleRef"
> & {
  caretRunSetter: RichTranslationSelectionState["setCaretRun"];
};

function useRecordVisualSelection({
  beforeInputRef,
  caretRunSetter,
  clearTypingStyle,
  composingRef,
  setSelection,
  typingOffsetRef,
  typingStyleRef,
}: RecordSelectionArgs): RichTranslationSelectionState["recordVisualSelection"] {
  return React.useCallback(
    (root, next) => {
      const inputInProgress =
        beforeInputRef.current !== null || composingRef.current;
      if (
        typingStyleRef.current &&
        !inputInProgress &&
        (next.start !== next.end || next.start !== typingOffsetRef.current)
      ) {
        clearTypingStyle();
      }
      setSelection(next);
      caretRunSetter(
        next.start === next.end ? getRichTextEditorCaretRun(root) : null,
      );
    },
    [
      beforeInputRef,
      caretRunSetter,
      clearTypingStyle,
      composingRef,
      setSelection,
      typingOffsetRef,
      typingStyleRef,
    ],
  );
}

function useResetRichTranslationState({
  beforeInputRef,
  blockId,
  clearTypingStyle,
  compositionBeforeInputRef,
  composingRef,
  compositionCommitTimerRef,
  compositionEndPendingRef,
}: Pick<
  RichTranslationSelectionState,
  | "beforeInputRef"
  | "clearTypingStyle"
  | "compositionBeforeInputRef"
  | "compositionCommitTimerRef"
  | "compositionEndPendingRef"
  | "composingRef"
> & { blockId: string }): void {
  React.useEffect(() => {
    clearTypingStyle();
    beforeInputRef.current = null;
    composingRef.current = false;
    compositionBeforeInputRef.current = null;
    compositionEndPendingRef.current = false;
    if (compositionCommitTimerRef.current !== null) {
      window.clearTimeout(compositionCommitTimerRef.current);
      compositionCommitTimerRef.current = null;
    }
    return () => {
      if (compositionCommitTimerRef.current !== null) {
        window.clearTimeout(compositionCommitTimerRef.current);
        compositionCommitTimerRef.current = null;
      }
    };
  }, [
    beforeInputRef,
    blockId,
    clearTypingStyle,
    compositionCommitTimerRef,
    compositionBeforeInputRef,
    compositionEndPendingRef,
    composingRef,
  ]);
}
