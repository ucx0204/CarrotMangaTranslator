import React from "react";
import {
  applyTextStyleToRuns,
  serializeRichTextRuns,
  type TextStyleRun,
} from "../../../shared/richTextMarkup";
import {
  clearRichTextEditorSelectionPreview,
  extractRichTextEditorRuns,
  getRichTextEditorCaretRun,
  getRichTextEditorSelection,
  insertPlainTextAtEditorSelection,
  restoreRichTextEditorSelection,
  type RichTextEditorRenderOptions,
  type RichTextEditorSelection,
} from "../lib/richTextEditorDom";
import type { RichTranslationEditorMode } from "./richTranslationEditorTypes";
import type { RichTranslationSelectionState } from "./useRichTranslationEditorState";
import {
  renderAndCacheRichTranslationRuns,
  useRichTranslationVisualRenderer,
  type RichTranslationVisualRenderCache,
} from "./useRichTranslationVisualRenderer";

type VisualEditorArgs = {
  blockId: string;
  mode: RichTranslationEditorMode;
  onChange: (value: string) => void;
  renderOptions: RichTextEditorRenderOptions;
  runs: readonly TextStyleRun[];
  selectionState: RichTranslationSelectionState;
  value: string;
};

export type RichTranslationVisualEditor = {
  captureSelectionBeforeControlFocus: React.PointerEventHandler<HTMLDivElement>;
  commitInput: (normalizeDom?: boolean) => void;
  commitRuns: (
    runs: readonly TextStyleRun[],
    selection?: RichTextEditorSelection,
  ) => void;
  onBeforeInput: () => void;
  onCompositionEnd: () => void;
  onCompositionStart: () => void;
  onPaste: React.ClipboardEventHandler<HTMLDivElement>;
  updateSelection: () => void;
  visualRef: React.MutableRefObject<HTMLDivElement | null>;
};

export function useRichTranslationVisualEditor(
  args: VisualEditorArgs,
): RichTranslationVisualEditor {
  const { cacheRef, visualRef } = useRichTranslationVisualRenderer({
    blockId: args.blockId,
    mode: args.mode,
    renderOptions: args.renderOptions,
    runs: args.runs,
    selectionRef: args.selectionState.selectionRef,
    value: args.value,
  });
  useVisualSelectionListener(args.mode, visualRef, args.selectionState);
  const commitRuns = useCommitVisualRuns(args, visualRef, cacheRef);
  const onBeforeInput = useCaptureVisualBeforeInput(
    visualRef,
    args.selectionState,
  );
  const commitInput = useCommitVisualInput(
    args,
    visualRef,
    cacheRef,
    commitRuns,
  );
  return {
    captureSelectionBeforeControlFocus: useCaptureSelectionBeforeControlFocus(
      args,
      visualRef,
      cacheRef,
    ),
    commitInput,
    commitRuns,
    onBeforeInput,
    ...useCompositionHandlers(args.selectionState, onBeforeInput, commitInput),
    onPaste: useVisualPasteHandler(commitInput),
    updateSelection: useUpdateVisualSelection(visualRef, args.selectionState),
    visualRef,
  };
}

function useVisualSelectionListener(
  mode: RichTranslationEditorMode,
  visualRef: React.MutableRefObject<HTMLDivElement | null>,
  state: RichTranslationSelectionState,
): void {
  React.useEffect(() => {
    if (mode !== "visual") return;
    const document = visualRef.current?.ownerDocument;
    if (!document) return;
    const update = (): void => {
      const root = visualRef.current;
      if (!root) return;
      const next = getRichTextEditorSelection(root);
      if (next) state.recordVisualSelection(root, next);
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [mode, state, visualRef]);
}

function useCommitVisualRuns(
  args: VisualEditorArgs,
  visualRef: React.MutableRefObject<HTMLDivElement | null>,
  cacheRef: React.MutableRefObject<RichTranslationVisualRenderCache>,
): RichTranslationVisualEditor["commitRuns"] {
  return React.useCallback(
    (runs, nextSelection = args.selectionState.selectionRef.current) => {
      const nextValue = serializeRichTextRuns(runs);
      const root = visualRef.current;
      cacheRef.current.value = nextValue;
      if (root) {
        const activeElement = root.ownerDocument.activeElement;
        renderAndCacheRichTranslationRuns(
          root,
          runs,
          args.renderOptions,
          root.contains(activeElement) ? null : nextSelection,
          nextValue,
          cacheRef,
        );
        if (root.contains(activeElement)) {
          restoreRichTextEditorSelection(root, nextSelection);
          args.selectionState.setCaretRun(
            nextSelection.start === nextSelection.end
              ? getRichTextEditorCaretRun(root)
              : null,
          );
        }
      }
      args.selectionState.setSelection(nextSelection);
      args.onChange(nextValue);
    },
    [args, cacheRef, visualRef],
  );
}

function useCaptureVisualBeforeInput(
  visualRef: React.MutableRefObject<HTMLDivElement | null>,
  state: RichTranslationSelectionState,
): () => void {
  return React.useCallback(() => {
    const root = visualRef.current;
    if (!root) return;
    const current = getRichTextEditorSelection(root);
    if (!current) return;
    state.beforeInputRef.current = {
      selection: current,
      style: state.typingStyleRef.current,
    };
    state.setSelection(current);
  }, [state, visualRef]);
}

function useCommitVisualInput(
  args: VisualEditorArgs,
  visualRef: React.MutableRefObject<HTMLDivElement | null>,
  cacheRef: React.MutableRefObject<RichTranslationVisualRenderCache>,
  commitRuns: RichTranslationVisualEditor["commitRuns"],
): RichTranslationVisualEditor["commitInput"] {
  return React.useCallback(
    (normalizeDom = false) =>
      commitVisualInput(
        args,
        visualRef.current,
        cacheRef,
        commitRuns,
        normalizeDom,
      ),
    [args, cacheRef, commitRuns, visualRef],
  );
}

function commitVisualInput(
  args: VisualEditorArgs,
  root: HTMLDivElement | null,
  cacheRef: React.MutableRefObject<RichTranslationVisualRenderCache>,
  commitRuns: RichTranslationVisualEditor["commitRuns"],
  normalizeDom: boolean,
): void {
  if (!root) return;
  const state = args.selectionState;
  const nextSelection =
    getRichTextEditorSelection(root) ?? state.selectionRef.current;
  const nextRuns = extractRichTextEditorRuns(root);
  const beforeInput = state.beforeInputRef.current;
  if (state.composingRef.current) {
    commitComposingInput(
      args.onChange,
      root,
      nextRuns,
      nextSelection,
      state,
      cacheRef,
    );
    return;
  }
  state.beforeInputRef.current = null;
  if (
    commitPendingTypingStyle(
      state,
      beforeInput,
      nextRuns,
      nextSelection,
      commitRuns,
    )
  ) {
    return;
  }
  if (normalizeDom) {
    commitRuns(nextRuns, nextSelection);
    return;
  }
  const nextValue = serializeRichTextRuns(nextRuns);
  cacheRef.current.value = nextValue;
  args.onChange(nextValue);
  state.recordVisualSelection(root, nextSelection);
}

function commitPendingTypingStyle(
  state: RichTranslationSelectionState,
  beforeInput: RichTranslationSelectionState["beforeInputRef"]["current"],
  runs: readonly TextStyleRun[],
  selection: RichTextEditorSelection,
  commitRuns: RichTranslationVisualEditor["commitRuns"],
): boolean {
  const pendingStyle = beforeInput?.style ?? state.typingStyleRef.current;
  const insertionStart =
    beforeInput?.selection.start ?? state.typingOffsetRef.current;
  if (!pendingStyle || insertionStart === null || !isCaret(selection)) {
    return false;
  }
  state.typingOffsetRef.current = selection.start;
  if (selection.start <= insertionStart) return false;
  commitRuns(
    applyTextStyleToRuns(runs, insertionStart, selection.start, pendingStyle),
    selection,
  );
  return true;
}

function commitComposingInput(
  onChange: (value: string) => void,
  root: HTMLElement,
  runs: readonly TextStyleRun[],
  selection: RichTextEditorSelection,
  state: RichTranslationSelectionState,
  cacheRef: React.MutableRefObject<RichTranslationVisualRenderCache>,
): void {
  const composingValue = serializeRichTextRuns(runs);
  cacheRef.current.value = composingValue;
  onChange(composingValue);
  state.setSelection(selection);
  state.setCaretRun(
    isCaret(selection) ? getRichTextEditorCaretRun(root) : null,
  );
}

function useCaptureSelectionBeforeControlFocus(
  args: VisualEditorArgs,
  visualRef: React.MutableRefObject<HTMLDivElement | null>,
  cacheRef: React.MutableRefObject<RichTranslationVisualRenderCache>,
): React.PointerEventHandler<HTMLDivElement> {
  return React.useCallback(
    (event) => {
      if (args.mode !== "visual") return;
      const root = visualRef.current;
      if (!root) return;
      if (root.contains(event.target as Node)) {
        clearRichTextEditorSelectionPreview(root);
        return;
      }
      const state = args.selectionState;
      const current =
        getRichTextEditorSelection(root) ?? state.selectionRef.current;
      if (isCaret(current)) state.setCaretRun(getRichTextEditorCaretRun(root));
      if (current.end <= current.start) return;
      state.setSelection(current);
      renderAndCacheRichTranslationRuns(
        root,
        args.runs,
        args.renderOptions,
        current,
        args.value,
        cacheRef,
      );
    },
    [args, cacheRef, visualRef],
  );
}

function useUpdateVisualSelection(
  visualRef: React.MutableRefObject<HTMLDivElement | null>,
  state: RichTranslationSelectionState,
): () => void {
  return React.useCallback(() => {
    const root = visualRef.current;
    if (!root) return;
    const next = getRichTextEditorSelection(root);
    if (next) state.recordVisualSelection(root, next);
  }, [state, visualRef]);
}

function useCompositionHandlers(
  state: RichTranslationSelectionState,
  captureBeforeInput: () => void,
  commitInput: RichTranslationVisualEditor["commitInput"],
): Pick<
  RichTranslationVisualEditor,
  "onCompositionStart" | "onCompositionEnd"
> {
  return {
    onCompositionStart: React.useCallback(() => {
      state.composingRef.current = true;
      captureBeforeInput();
    }, [captureBeforeInput, state.composingRef]),
    onCompositionEnd: React.useCallback(() => {
      state.composingRef.current = false;
      commitInput(true);
    }, [commitInput, state.composingRef]),
  };
}

function useVisualPasteHandler(
  commitInput: RichTranslationVisualEditor["commitInput"],
): React.ClipboardEventHandler<HTMLDivElement> {
  return React.useCallback(
    (event) => {
      event.preventDefault();
      if (
        insertPlainTextAtEditorSelection(
          event.currentTarget,
          event.clipboardData.getData("text/plain"),
        )
      ) {
        commitInput();
      }
    },
    [commitInput],
  );
}

function isCaret(selection: RichTextEditorSelection): boolean {
  return selection.start === selection.end;
}
