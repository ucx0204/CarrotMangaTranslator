import React from "react";
import {
  applyTextStyleToRuns,
  parseRichText,
  type TextStylePatch,
} from "../../../shared/richTextMarkup";
import type { TranslationBlock } from "../../../shared/textTypes";
import { useFonts } from "../fonts/useFonts";
import {
  insertPlainTextAtEditorSelection,
  restoreRichTextEditorSelection,
  type RichTextEditorRenderOptions,
} from "../lib/richTextEditorDom";
import { resolveBlockFontFamily, type BlockFontCatalog } from "../lib/fonts";
import { applyRichTranslationCodeStyle } from "./richTranslationCodeFormatting";
import type { RichTranslationEditorMode } from "./richTranslationEditorTypes";
import {
  normalizeRichTextOpacity,
  resolveRichTranslationCodeSelection,
  resolveRichTranslationSelectionValues,
} from "./richTranslationSelectionModel";
import {
  useRichTranslationCodeEditor,
  type RichTranslationCodeEditor,
} from "./useRichTranslationCodeEditor";
import {
  useRichTranslationEditorState,
  type RichTranslationSelectionState,
} from "./useRichTranslationEditorState";
import { useRichTranslationSpecialCharacters } from "./useRichTranslationSpecialCharacters";
import {
  useRichTranslationVisualEditor,
  type RichTranslationVisualEditor,
} from "./useRichTranslationVisualEditor";

const EDITOR_MODE_STORAGE_KEY = "editor.richText.mode";

type RichTranslationEditorControllerArgs = {
  block: TranslationBlock;
  editorRootRef: React.RefObject<HTMLDivElement | null>;
  onChange: (value: string) => void;
  value: string;
};

export type RichTranslationEditorController = {
  applyInlineStyle: (patch: TextStylePatch) => void;
  clearAllFormatting: () => void;
  code: RichTranslationCodeEditor;
  insertSpecialCharacter: (character: string) => void;
  mode: RichTranslationEditorMode;
  plainText: string;
  selectionValues: ReturnType<typeof resolveRichTranslationSelectionValues>;
  setMode: (mode: RichTranslationEditorMode) => void;
  specialCharacters: ReturnType<typeof useRichTranslationSpecialCharacters>;
  visual: RichTranslationVisualEditor;
};

export function useRichTranslationEditorController({
  block,
  editorRootRef,
  onChange,
  value,
}: RichTranslationEditorControllerArgs): RichTranslationEditorController {
  const { catalog } = useFonts();
  const parsed = React.useMemo(() => parseRichText(value), [value]);
  const renderOptions = useRichTextRenderOptions(block, catalog);
  const state = useRichTranslationEditorState(block.id);
  const [mode, setModeState] =
    React.useState<RichTranslationEditorMode>(readStoredMode);
  const specialCharacters = useRichTranslationSpecialCharacters(
    block.id,
    editorRootRef,
  );
  const code = useRichTranslationCodeEditor({
    mode,
    onChange,
    setSelection: state.setSelection,
    value,
  });
  const visual = useRichTranslationVisualEditor({
    blockId: block.id,
    mode,
    onChange,
    renderOptions,
    runs: parsed.runs,
    selectionState: state,
    value,
  });
  const actionArgs = {
    block,
    code,
    mode,
    onChange,
    parsed,
    state,
    value,
    visual,
  };
  return {
    applyInlineStyle: useApplyInlineStyle(actionArgs),
    clearAllFormatting: useClearAllFormatting(actionArgs),
    code,
    insertSpecialCharacter: useInsertSpecialCharacter({
      ...actionArgs,
      close: specialCharacters.close,
    }),
    mode,
    plainText: parsed.plainText,
    selectionValues: useSelectionValues(block, mode, parsed, state, value),
    setMode: useSetEditorMode(setModeState, state, specialCharacters.close),
    specialCharacters,
    visual,
  };
}

type RichTranslationActionArgs = {
  block: TranslationBlock;
  code: RichTranslationCodeEditor;
  mode: RichTranslationEditorMode;
  onChange: (value: string) => void;
  parsed: ReturnType<typeof parseRichText>;
  state: RichTranslationSelectionState;
  value: string;
  visual: RichTranslationVisualEditor;
};

function useRichTextRenderOptions(
  block: TranslationBlock,
  catalog: BlockFontCatalog,
): RichTextEditorRenderOptions {
  return React.useMemo(
    () => ({
      block,
      baseBold: Boolean(block.bold),
      baseItalic: Boolean(block.italic),
      baseFontSizePx: block.fontSizePx,
      baseFontFamily: resolveBlockFontFamily(block.fontFamily, catalog),
      baseOpacity: normalizeRichTextOpacity(block.textOpacity),
      resolveFontFamily: (fontId: string | undefined) =>
        resolveBlockFontFamily(fontId ?? block.fontFamily, catalog),
    }),
    [block, catalog],
  );
}

function useSetEditorMode(
  setMode: React.Dispatch<React.SetStateAction<RichTranslationEditorMode>>,
  state: RichTranslationSelectionState,
  closeSpecialCharacters: () => void,
): (mode: RichTranslationEditorMode) => void {
  return React.useCallback(
    (next) => {
      setMode(next);
      closeSpecialCharacters();
      state.setSelection({ start: 0, end: 0 });
      state.setCaretRun(null);
      state.clearTypingStyle();
      window.localStorage.setItem(EDITOR_MODE_STORAGE_KEY, next);
    },
    [closeSpecialCharacters, setMode, state],
  );
}

function useSelectionValues(
  block: TranslationBlock,
  mode: RichTranslationEditorMode,
  parsed: ReturnType<typeof parseRichText>,
  state: RichTranslationSelectionState,
  value: string,
): ReturnType<typeof resolveRichTranslationSelectionValues> {
  return React.useMemo(() => {
    const resolvedSelection =
      mode === "visual"
        ? state.selection
        : resolveRichTranslationCodeSelection(
            value,
            state.selection,
            parsed.plainText.length,
          );
    return resolveRichTranslationSelectionValues(
      parsed.runs,
      resolvedSelection,
      block,
      mode === "visual" ? state.caretRun : null,
      mode === "visual" ? state.typingStyle : null,
    );
  }, [block, mode, parsed, state, value]);
}

function useApplyInlineStyle({
  code,
  mode,
  parsed,
  state,
  value,
  visual,
}: RichTranslationActionArgs): (patch: TextStylePatch) => void {
  return React.useCallback(
    (patch) => {
      const target = state.selectionRef.current;
      if (mode === "visual") {
        if (target.end <= target.start) {
          state.updateTypingStyle(patch);
          return;
        }
        state.clearTypingStyle();
        visual.commitRuns(
          applyTextStyleToRuns(parsed.runs, target.start, target.end, patch),
        );
        return;
      }
      if (!code.codeRef.current) return;
      const result = applyRichTranslationCodeStyle(value, target, patch);
      if (result) code.commitResult(result);
    },
    [code, mode, parsed.runs, state, value, visual],
  );
}

function useClearAllFormatting({
  code,
  mode,
  parsed,
  state,
  visual,
}: RichTranslationActionArgs): () => void {
  return React.useCallback(() => {
    const nextSelection = {
      start: Math.min(state.selection.start, parsed.plainText.length),
      end: Math.min(state.selection.end, parsed.plainText.length),
    };
    if (mode === "visual") {
      visual.commitRuns(parseRichText(parsed.plainText).runs, nextSelection);
      return;
    }
    code.commitResult({
      value: parsed.plainText,
      selectionStart: nextSelection.start,
      selectionEnd: nextSelection.end,
    });
  }, [code, mode, parsed.plainText, state.selection, visual]);
}

function useInsertSpecialCharacter(
  args: RichTranslationActionArgs & { close: () => void },
): (character: string) => void {
  return React.useCallback(
    (character) => {
      args.close();
      if (args.mode === "visual") {
        insertVisualCharacter(character, args);
        return;
      }
      const codeElement = args.code.codeRef.current;
      const start = codeElement
        ? Math.min(codeElement.selectionStart, codeElement.selectionEnd)
        : args.state.selectionRef.current.start;
      const end = codeElement
        ? Math.max(codeElement.selectionStart, codeElement.selectionEnd)
        : args.state.selectionRef.current.end;
      const caret = start + character.length;
      args.code.commitResult({
        value: `${args.value.slice(0, start)}${character}${args.value.slice(end)}`,
        selectionStart: caret,
        selectionEnd: caret,
      });
    },
    [args],
  );
}

function insertVisualCharacter(
  character: string,
  args: RichTranslationActionArgs,
): void {
  const root = args.visual.visualRef.current;
  if (!root) return;
  const current = args.state.selectionRef.current;
  root.focus();
  restoreRichTextEditorSelection(root, current);
  args.state.beforeInputRef.current = {
    selection: current,
    style: args.state.typingStyleRef.current,
  };
  if (insertPlainTextAtEditorSelection(root, character)) {
    args.visual.commitInput();
  }
}

function readStoredMode(): RichTranslationEditorMode {
  if (typeof window === "undefined") return "visual";
  return window.localStorage.getItem(EDITOR_MODE_STORAGE_KEY) === "code"
    ? "code"
    : "visual";
}
