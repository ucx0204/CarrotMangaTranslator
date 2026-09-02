import React from "react";
import type { RichTextEditorSelection } from "../lib/richTextEditorDom";
import type { InlineMarkupResult } from "../lib/textareaMarkup";
import type { RichTranslationEditorMode } from "./richTranslationEditorTypes";

type RichTranslationCodeEditorArgs = {
  mode: RichTranslationEditorMode;
  onChange: (value: string) => void;
  setSelection: (selection: RichTextEditorSelection) => void;
  value: string;
};

export type RichTranslationCodeEditor = {
  codeRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  commitResult: (result: InlineMarkupResult) => void;
  onSelect: React.ReactEventHandler<HTMLTextAreaElement>;
};

export function useRichTranslationCodeEditor({
  mode,
  onChange,
  setSelection,
  value,
}: RichTranslationCodeEditorArgs): RichTranslationCodeEditor {
  const codeRef = React.useRef<HTMLTextAreaElement | null>(null);
  const pendingSelectionRef = React.useRef<RichTextEditorSelection | null>(
    null,
  );
  React.useLayoutEffect(() => {
    if (mode !== "code") return;
    const pending = pendingSelectionRef.current;
    const element = codeRef.current;
    if (!pending || !element) return;
    pendingSelectionRef.current = null;
    element.focus();
    element.setSelectionRange(pending.start, pending.end);
  }, [mode, value]);
  const commitResult = React.useCallback(
    (result: InlineMarkupResult): void => {
      const nextSelection = {
        start: result.selectionStart,
        end: result.selectionEnd,
      };
      pendingSelectionRef.current = nextSelection;
      onChange(result.value);
      setSelection(nextSelection);
    },
    [onChange, setSelection],
  );
  const onSelect = React.useCallback<
    React.ReactEventHandler<HTMLTextAreaElement>
  >(
    (event) =>
      setSelection({
        start: event.currentTarget.selectionStart,
        end: event.currentTarget.selectionEnd,
      }),
    [setSelection],
  );
  return { codeRef, commitResult, onSelect };
}
