/* eslint-disable max-lines, max-lines-per-function, complexity -- visual/code mode selection, IME composition, and caret-only typing style form one focus-sensitive editor transaction */
import React from "react";
import { useTranslation } from "react-i18next";
import {
  applyTextStyleToRuns,
  parseRichText,
  serializeRichTextRuns,
  type TextStylePatch,
  type TextStyleRun,
} from "../../../shared/richTextMarkup";
import {
  FONT_SIZE_STEP_PX,
  MAX_FONT_SIZE_PX,
  MIN_FONT_SIZE_PX,
} from "../../../shared/blockFormatValues";
import { DEFAULT_BLOCK_FONT_ID } from "../../../shared/blockFontCatalog";
import {
  MAX_TEXT_GLOW_BLUR_PX,
  MIN_TEXT_GLOW_BLUR_PX,
  resolveTextGlow,
} from "../../../shared/textGlow";
import {
  MAX_TEXT_OUTLINE_WIDTH_PX,
  MIN_TEXT_OUTLINE_WIDTH_PX,
  TEXT_OUTLINE_WIDTH_STEP_PX,
  resolveEffectiveTextColor,
  resolveEffectiveTextOutlineColor,
  resolveEffectiveTextOutlineWidthPx,
} from "../../../shared/textOutline";
import type { TranslationBlock } from "../../../shared/textTypes";
import { useFonts } from "../fonts/useFonts";
import {
  clearRichTextEditorSelectionPreview,
  extractRichTextEditorRuns,
  getRichTextEditorCaretRun,
  getRichTextEditorSelection,
  insertPlainTextAtEditorSelection,
  renderRichTextEditorRuns,
  restoreRichTextEditorSelection,
  type RichTextEditorRenderOptions,
  type RichTextEditorSelection,
} from "../lib/richTextEditorDom";
import {
  applyInlineBooleanStyleTag,
  applyInlineMarkup,
  applyInlineStyleTag,
  type InlineMarkupResult,
} from "../lib/textareaMarkup";
import { resolveBlockFontFamily } from "../lib/fonts";
import { IconButton } from "./ui/IconButton";
import { NumberField } from "./ui/NumberField";
import { CheckboxField } from "./ui/CheckboxField";
import {
  BoldIcon,
  CodeIcon,
  EmphasisMarkIcon,
  ItalicIcon,
  RestoreIcon,
  StrikethroughIcon,
  TypeStyleIcon,
  UnderlineIcon,
} from "./ui/icons";
import { FontSelect } from "./FontSelect";
import { ColorField } from "./ColorField";

type EditorMode = "visual" | "code";

type RichTranslationEditorProps = {
  afterEditor?: React.ReactNode;
  block: TranslationBlock;
  disabled: boolean;
  editorRootRef: React.RefObject<HTMLDivElement | null>;
  heightRefCallback: (element: HTMLElement | null) => void;
  onChange: (value: string) => void;
  value: string;
};

const EDITOR_MODE_STORAGE_KEY = "editor.richText.mode";
const MIN_INLINE_WIDTH_PERCENT = 10;
const MAX_INLINE_WIDTH_PERCENT = 500;
type SpecialCharacterOption = {
  text: string;
  combineUpright?: boolean;
};
const SPECIAL_CHARACTERS: readonly SpecialCharacterOption[] = [
  { text: "…" },
  { text: "—" },
  { text: "〜" },
  { text: "!!", combineUpright: true },
  { text: "!?", combineUpright: true },
  { text: "?!", combineUpright: true },
  { text: "??", combineUpright: true },
  { text: "♡" },
  { text: "♥" },
  { text: "♪" },
  { text: "♬" },
];

export function RichTranslationEditor({
  afterEditor,
  block,
  disabled,
  editorRootRef,
  heightRefCallback,
  onChange,
  value,
}: RichTranslationEditorProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const { catalog } = useFonts();
  const [mode, setMode] = React.useState<EditorMode>(readStoredMode);
  const [specialCharactersOpen, setSpecialCharactersOpen] =
    React.useState(false);
  const specialCharactersId = React.useId();
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
  const visualRef = React.useRef<HTMLDivElement | null>(null);
  const codeRef = React.useRef<HTMLTextAreaElement | null>(null);
  const lastDomValueRef = React.useRef<string | null>(null);
  const lastRenderedRootRef = React.useRef<HTMLElement | null>(null);
  const lastRenderOptionsRef = React.useRef<RichTextEditorRenderOptions | null>(
    null,
  );
  const blockIdRef = React.useRef(block.id);
  const pendingCodeSelectionRef = React.useRef<RichTextEditorSelection | null>(
    null,
  );
  const parsed = React.useMemo(() => parseRichText(value), [value]);

  const renderOptions = React.useMemo<RichTextEditorRenderOptions>(
    () => ({
      block,
      baseBold: Boolean(block.bold),
      baseItalic: Boolean(block.italic),
      baseFontSizePx: block.fontSizePx,
      baseFontFamily: resolveBlockFontFamily(block.fontFamily, catalog),
      baseOpacity: normalizeOpacity(block.textOpacity),
      resolveFontFamily: (fontId) =>
        resolveBlockFontFamily(fontId ?? block.fontFamily, catalog),
    }),
    [block, catalog],
  );

  const setSelection = React.useCallback(
    (next: RichTextEditorSelection): void => {
      selectionRef.current = next;
      setSelectionState(next);
    },
    [],
  );

  const clearTypingStyle = React.useCallback((): void => {
    typingStyleRef.current = null;
    typingOffsetRef.current = null;
    setTypingStyleState(null);
  }, []);

  const updateTypingStyle = React.useCallback((patch: TextStylePatch): void => {
    const next = { ...(typingStyleRef.current ?? {}), ...patch };
    typingStyleRef.current = next;
    typingOffsetRef.current = selectionRef.current.start;
    setTypingStyleState(next);
  }, []);

  const recordVisualSelection = React.useCallback(
    (root: HTMLElement, next: RichTextEditorSelection): void => {
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
      setCaretRun(
        next.start === next.end ? getRichTextEditorCaretRun(root) : null,
      );
    },
    [clearTypingStyle, setSelection],
  );

  React.useLayoutEffect(() => {
    const root = visualRef.current;
    if (!root || mode !== "visual") return;
    const switchedBlock = blockIdRef.current !== block.id;
    blockIdRef.current = block.id;
    if (
      !switchedBlock &&
      lastDomValueRef.current === value &&
      lastRenderOptionsRef.current === renderOptions &&
      lastRenderedRootRef.current === root
    ) {
      return;
    }
    const activeElement = root.ownerDocument.activeElement;
    const editor = root.closest(".rich-translation-editor");
    const showSavedSelection = Boolean(
      editor?.contains(activeElement) &&
      !root.contains(activeElement) &&
      selectionRef.current.end > selectionRef.current.start,
    );
    renderRichTextEditorRuns(
      root,
      parsed.runs,
      renderOptions,
      showSavedSelection ? selectionRef.current : null,
    );
    lastDomValueRef.current = value;
    lastRenderOptionsRef.current = renderOptions;
    lastRenderedRootRef.current = root;
  }, [block.id, mode, parsed.runs, renderOptions, value]);

  React.useEffect(() => {
    if (mode !== "visual") return;
    const document = visualRef.current?.ownerDocument;
    if (!document) return;
    const update = (): void => {
      const root = visualRef.current;
      if (!root) return;
      const next = getRichTextEditorSelection(root);
      if (!next) return;
      recordVisualSelection(root, next);
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [mode, recordVisualSelection]);

  React.useEffect(() => {
    clearTypingStyle();
    beforeInputRef.current = null;
    composingRef.current = false;
    setSpecialCharactersOpen(false);
  }, [block.id, clearTypingStyle]);

  React.useEffect(() => {
    if (!specialCharactersOpen) return;
    const document = editorRootRef.current?.ownerDocument;
    if (!document) return;
    const closeOutside = (event: PointerEvent): void => {
      if (!editorRootRef.current?.contains(event.target as Node)) {
        setSpecialCharactersOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setSpecialCharactersOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [editorRootRef, specialCharactersOpen]);

  React.useLayoutEffect(() => {
    if (mode !== "code") return;
    const pending = pendingCodeSelectionRef.current;
    const element = codeRef.current;
    if (!pending || !element) return;
    pendingCodeSelectionRef.current = null;
    element.focus();
    element.setSelectionRange(pending.start, pending.end);
  }, [mode, value]);

  const setEditorMode = (next: EditorMode): void => {
    setMode(next);
    setSpecialCharactersOpen(false);
    setSelection({ start: 0, end: 0 });
    setCaretRun(null);
    clearTypingStyle();
    window.localStorage.setItem(EDITOR_MODE_STORAGE_KEY, next);
  };

  const updateVisualSelection = (): void => {
    const root = visualRef.current;
    if (!root) return;
    const next = getRichTextEditorSelection(root);
    if (!next) return;
    recordVisualSelection(root, next);
  };

  const captureVisualSelectionBeforeControlFocus = (
    event: React.PointerEvent<HTMLDivElement>,
  ): void => {
    if (mode !== "visual") return;
    const root = visualRef.current;
    if (!root) return;
    if (root.contains(event.target as Node)) {
      clearRichTextEditorSelectionPreview(root);
      return;
    }
    const current = getRichTextEditorSelection(root) ?? selectionRef.current;
    if (current.start === current.end) {
      setCaretRun(getRichTextEditorCaretRun(root));
    }
    if (current.end <= current.start) return;
    setSelection(current);
    renderRichTextEditorRuns(root, parsed.runs, renderOptions, current);
    lastDomValueRef.current = value;
    lastRenderOptionsRef.current = renderOptions;
    lastRenderedRootRef.current = root;
  };

  const captureVisualBeforeInput = (): void => {
    const root = visualRef.current;
    if (!root) return;
    const current = getRichTextEditorSelection(root);
    if (!current) return;
    beforeInputRef.current = {
      selection: current,
      style: typingStyleRef.current,
    };
    setSelection(current);
  };

  const commitVisualInput = (): void => {
    const root = visualRef.current;
    if (!root) return;
    const nextSelection =
      getRichTextEditorSelection(root) ?? selectionRef.current;
    const nextRuns = extractRichTextEditorRuns(root);
    const beforeInput = beforeInputRef.current;
    if (composingRef.current) {
      const composingValue = serializeRichTextRuns(nextRuns);
      lastDomValueRef.current = composingValue;
      onChange(composingValue);
      setSelection(nextSelection);
      setCaretRun(
        nextSelection.start === nextSelection.end
          ? getRichTextEditorCaretRun(root)
          : null,
      );
      return;
    }
    beforeInputRef.current = null;
    const pendingStyle = beforeInput?.style ?? typingStyleRef.current;
    const insertionStart =
      beforeInput?.selection.start ?? typingOffsetRef.current;
    if (
      pendingStyle &&
      insertionStart !== null &&
      nextSelection.start === nextSelection.end
    ) {
      typingOffsetRef.current = nextSelection.start;
      if (nextSelection.start > insertionStart) {
        commitVisualRuns(
          applyTextStyleToRuns(
            nextRuns,
            insertionStart,
            nextSelection.start,
            pendingStyle,
          ),
          nextSelection,
        );
        return;
      }
    }
    const nextValue = serializeRichTextRuns(nextRuns);
    lastDomValueRef.current = nextValue;
    onChange(nextValue);
    recordVisualSelection(root, nextSelection);
  };

  const commitVisualRuns = (
    runs: readonly TextStyleRun[],
    nextSelection = selectionRef.current,
  ): void => {
    const nextValue = serializeRichTextRuns(runs);
    const root = visualRef.current;
    lastDomValueRef.current = nextValue;
    if (root) {
      const activeElement = root.ownerDocument.activeElement;
      const showSavedSelection = !root.contains(activeElement);
      renderRichTextEditorRuns(
        root,
        runs,
        renderOptions,
        showSavedSelection ? nextSelection : null,
      );
      lastRenderOptionsRef.current = renderOptions;
      lastRenderedRootRef.current = root;
      if (root.contains(activeElement)) {
        restoreRichTextEditorSelection(root, nextSelection);
        setCaretRun(
          nextSelection.start === nextSelection.end
            ? getRichTextEditorCaretRun(root)
            : null,
        );
      }
    }
    setSelection(nextSelection);
    onChange(nextValue);
  };

  const commitCodeResult = (result: InlineMarkupResult): void => {
    const nextSelection = {
      start: result.selectionStart,
      end: result.selectionEnd,
    };
    pendingCodeSelectionRef.current = nextSelection;
    onChange(result.value);
    setSelection(nextSelection);
  };

  const selectionValues = React.useMemo(
    () =>
      resolveSelectionValues(
        parsed.runs,
        mode === "visual" ? selection : { start: 0, end: 0 },
        block,
        mode === "visual" ? caretRun : null,
        mode === "visual" ? typingStyle : null,
      ),
    [block, caretRun, mode, parsed.runs, selection, typingStyle],
  );

  const applyInlineStyle = (patch: TextStylePatch): void => {
    const target = selectionRef.current;
    const targetHasSelection = target.end > target.start;
    if (mode === "visual") {
      if (!targetHasSelection) {
        updateTypingStyle(patch);
        return;
      }
      clearTypingStyle();
      commitVisualRuns(
        applyTextStyleToRuns(parsed.runs, target.start, target.end, patch),
      );
      return;
    }
    const code = codeRef.current;
    if (!code) return;
    if (patch.bold !== undefined) {
      commitCodeResult(
        applyInlineMarkup(value, target.start, target.end, "**"),
      );
    } else if (patch.italic !== undefined) {
      commitCodeResult(applyInlineMarkup(value, target.start, target.end, "*"));
    } else if (patch.underline !== undefined) {
      commitCodeResult(
        applyInlineBooleanStyleTag(
          value,
          target.start,
          target.end,
          "underline",
        ),
      );
    } else if (patch.strikethrough !== undefined) {
      commitCodeResult(
        applyInlineBooleanStyleTag(value, target.start, target.end, "strike"),
      );
    } else if (patch.emphasisMark !== undefined) {
      commitCodeResult(
        applyInlineBooleanStyleTag(value, target.start, target.end, "emphasis"),
      );
    } else if (patch.verticalCombine !== undefined) {
      commitCodeResult(
        applyInlineBooleanStyleTag(value, target.start, target.end, "tcy"),
      );
    } else if (patch.sizePx !== undefined && patch.sizePx !== null) {
      commitCodeResult(
        applyInlineStyleTag(
          value,
          target.start,
          target.end,
          "size",
          patch.sizePx,
        ),
      );
    } else if (patch.fontFamily !== undefined && patch.fontFamily !== null) {
      commitCodeResult(
        applyInlineStyleTag(
          value,
          target.start,
          target.end,
          "font",
          patch.fontFamily,
        ),
      );
    } else if (patch.opacity !== undefined && patch.opacity !== null) {
      commitCodeResult(
        applyInlineStyleTag(
          value,
          target.start,
          target.end,
          "opacity",
          formatNumber(patch.opacity * 100),
        ),
      );
    } else if (patch.widthScale !== undefined && patch.widthScale !== null) {
      commitCodeResult(
        applyInlineStyleTag(
          value,
          target.start,
          target.end,
          "width",
          formatNumber(patch.widthScale),
        ),
      );
    } else if (patch.color) {
      commitCodeResult(
        applyInlineStyleTag(
          value,
          target.start,
          target.end,
          "color",
          patch.color,
        ),
      );
    } else if (patch.backgroundColor) {
      commitCodeResult(
        applyInlineStyleTag(
          value,
          target.start,
          target.end,
          "background",
          patch.backgroundColor,
        ),
      );
    } else if (patch.outlineColor) {
      commitCodeResult(
        applyInlineStyleTag(
          value,
          target.start,
          target.end,
          "outline-color",
          patch.outlineColor,
        ),
      );
    } else if (
      patch.outlineWidthPx !== undefined &&
      patch.outlineWidthPx !== null
    ) {
      commitCodeResult(
        applyInlineStyleTag(
          value,
          target.start,
          target.end,
          "outline-width",
          formatNumber(patch.outlineWidthPx),
        ),
      );
    } else if (patch.outerOutlineColor) {
      commitCodeResult(
        applyInlineStyleTag(
          value,
          target.start,
          target.end,
          "outer-outline-color",
          patch.outerOutlineColor,
        ),
      );
    } else if (
      patch.outerOutlineWidthPx !== undefined &&
      patch.outerOutlineWidthPx !== null
    ) {
      commitCodeResult(
        applyInlineStyleTag(
          value,
          target.start,
          target.end,
          "outer-outline-width",
          formatNumber(patch.outerOutlineWidthPx),
        ),
      );
    } else if (patch.glowColor) {
      commitCodeResult(
        applyInlineStyleTag(
          value,
          target.start,
          target.end,
          "glow-color",
          patch.glowColor,
        ),
      );
    } else if (patch.glowBlurPx !== undefined && patch.glowBlurPx !== null) {
      commitCodeResult(
        applyInlineStyleTag(
          value,
          target.start,
          target.end,
          "glow-blur",
          formatNumber(patch.glowBlurPx),
        ),
      );
    } else if (patch.glowOpacity !== undefined && patch.glowOpacity !== null) {
      commitCodeResult(
        applyInlineStyleTag(
          value,
          target.start,
          target.end,
          "glow-opacity",
          formatNumber(patch.glowOpacity),
        ),
      );
    }
  };

  const clearAllFormatting = (): void => {
    const plainText = parsed.plainText;
    const nextSelection = {
      start: Math.min(selection.start, plainText.length),
      end: Math.min(selection.end, plainText.length),
    };
    if (mode === "visual") {
      commitVisualRuns(parseRichText(plainText).runs, nextSelection);
    } else {
      commitCodeResult({
        value: plainText,
        ...nextSelectionToResult(nextSelection),
      });
    }
  };

  const insertSpecialCharacter = (option: SpecialCharacterOption): void => {
    const character = option.text;
    setSpecialCharactersOpen(false);
    if (mode === "visual") {
      const root = visualRef.current;
      if (!root) return;
      const current = selectionRef.current;
      root.focus();
      restoreRichTextEditorSelection(root, current);
      beforeInputRef.current = {
        selection: current,
        style: typingStyleRef.current,
      };
      if (!insertPlainTextAtEditorSelection(root, character)) return;
      if (!option.combineUpright) {
        commitVisualInput();
        return;
      }
      beforeInputRef.current = null;
      const nextSelection =
        getRichTextEditorSelection(root) ??
        ({
          start: current.start + character.length,
          end: current.start + character.length,
        } satisfies RichTextEditorSelection);
      const previousTypingStyle = typingStyleRef.current;
      const patch: TextStylePatch = {
        ...(previousTypingStyle ?? {}),
        verticalCombine: true,
      };
      commitVisualRuns(
        applyTextStyleToRuns(
          extractRichTextEditorRuns(root),
          current.start,
          current.start + character.length,
          patch,
        ),
        nextSelection,
      );
      const resumedTypingStyle: TextStylePatch = {
        ...(previousTypingStyle ?? {}),
        verticalCombine: null,
      };
      typingStyleRef.current = resumedTypingStyle;
      typingOffsetRef.current = nextSelection.start;
      setTypingStyleState(resumedTypingStyle);
      return;
    }
    const code = codeRef.current;
    const start = code
      ? Math.min(code.selectionStart, code.selectionEnd)
      : selectionRef.current.start;
    const end = code
      ? Math.max(code.selectionStart, code.selectionEnd)
      : selectionRef.current.end;
    const inserted = option.combineUpright
      ? `[tcy]${character}[/tcy]`
      : character;
    const caret = start + inserted.length;
    commitCodeResult({
      value: `${value.slice(0, start)}${inserted}${value.slice(end)}`,
      selectionStart: caret,
      selectionEnd: caret,
    });
  };

  return (
    <div
      className="rich-translation-editor"
      ref={editorRootRef}
      onPointerDownCapture={captureVisualSelectionBeforeControlFocus}
    >
      <div className="rich-editor-header">
        <div className="rich-editor-heading">
          <h3>{t("editor.translatedText")}</h3>
          <div
            className="rich-editor-mode-toggle"
            aria-label={t("editor.richText.modeLabel", {
              defaultValue: "번역문 보기 방식",
            })}
          >
            <button
              type="button"
              aria-pressed={mode === "visual"}
              onClick={() => setEditorMode("visual")}
            >
              <TypeStyleIcon size={13} />
              {t("editor.richText.visualMode", { defaultValue: "편집" })}
            </button>
            <button
              type="button"
              aria-pressed={mode === "code"}
              onClick={() => setEditorMode("code")}
            >
              <CodeIcon size={13} />
              {t("editor.richText.codeMode", { defaultValue: "코드" })}
            </button>
          </div>
        </div>
        <div className="rich-editor-toolbar">
          <button
            type="button"
            className="rich-special-character-trigger"
            aria-controls={specialCharactersId}
            aria-expanded={specialCharactersOpen}
            disabled={disabled}
            onClick={() => setSpecialCharactersOpen((open) => !open)}
          >
            <span aria-hidden="true">Ω</span>
            {t("editor.richText.specialCharacters", {
              defaultValue: "기호",
            })}
          </button>
          <IconButton
            size="sm"
            label={t("editor.richText.resetAll", {
              defaultValue: "번역문 서식 전체 초기화",
            })}
            title={t("editor.richText.resetAllTitle", {
              defaultValue: "번역문 안의 모든 강조와 글자별 서식 제거",
            })}
            disabled={disabled || parsed.plainText === value}
            onClick={clearAllFormatting}
          >
            <RestoreIcon size={14} />
          </IconButton>
        </div>
      </div>

      {specialCharactersOpen ? (
        <div
          id={specialCharactersId}
          className="rich-special-character-panel"
          role="group"
          aria-label={t("editor.richText.specialCharacters", {
            defaultValue: "특수문자",
          })}
        >
          {SPECIAL_CHARACTERS.map((option) => (
            <button
              type="button"
              key={option.text}
              title={t("editor.richText.insertSpecialCharacter", {
                character: option.text,
                defaultValue: "{{character}} 입력",
              })}
              disabled={disabled}
              onClick={() => insertSpecialCharacter(option)}
            >
              {option.text}
            </button>
          ))}
        </div>
      ) : null}

      {mode === "visual" ? (
        <div
          ref={(element) => {
            visualRef.current = element;
            heightRefCallback(element);
          }}
          className="rich-editor-surface"
          data-rich-translated-input=""
          contentEditable={!disabled}
          suppressContentEditableWarning
          role="textbox"
          aria-label={t("editor.translatedText")}
          aria-multiline="true"
          aria-readonly={disabled || undefined}
          data-empty={parsed.plainText.length === 0 ? "true" : undefined}
          data-placeholder={t("editor.richText.placeholder", {
            defaultValue: "번역문을 입력하세요",
          })}
          onInput={commitVisualInput}
          onBeforeInput={captureVisualBeforeInput}
          onCompositionStart={() => {
            composingRef.current = true;
            captureVisualBeforeInput();
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            commitVisualInput();
          }}
          onKeyUp={updateVisualSelection}
          onPointerUp={updateVisualSelection}
          onPaste={(event) => {
            event.preventDefault();
            if (
              insertPlainTextAtEditorSelection(
                event.currentTarget,
                event.clipboardData.getData("text/plain"),
              )
            ) {
              commitVisualInput();
            }
          }}
        />
      ) : (
        <textarea
          ref={(element) => {
            codeRef.current = element;
            heightRefCallback(element);
          }}
          className="rich-editor-code"
          data-rich-translated-input=""
          aria-label={t("editor.richText.codeAria", {
            defaultValue: "번역문 서식 코드",
          })}
          value={value}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          onSelect={(event) =>
            setSelection({
              start: event.currentTarget.selectionStart,
              end: event.currentTarget.selectionEnd,
            })
          }
        />
      )}
      {afterEditor}
      <InlineStylePanel
        disabled={disabled}
        mode={mode}
        values={selectionValues}
        onApplyStyle={applyInlineStyle}
      />
    </div>
  );
}

type SelectionValues = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  emphasisMark: boolean;
  verticalCombine: boolean;
  sizePx: number;
  sizeMixed: boolean;
  fontFamily: string | undefined;
  fontMixed: boolean;
  opacityPercent: number;
  opacityMixed: boolean;
  widthPercent: number;
  color: string;
  backgroundEnabled: boolean;
  backgroundColor: string;
  outlineEnabled: boolean;
  outlineColor: string;
  outlineWidthPx: number;
  outerOutlineEnabled: boolean;
  outerOutlineColor: string;
  outerOutlineWidthPx: number;
  glowEnabled: boolean;
  glowColor: string;
  glowBlurPx: number;
  glowOpacityPercent: number;
};

function InlineStylePanel({
  disabled,
  mode,
  values,
  onApplyStyle,
}: {
  disabled: boolean;
  mode: EditorMode;
  values: SelectionValues;
  onApplyStyle: (patch: TextStylePatch) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const toggle = (
    key:
      | "bold"
      | "italic"
      | "underline"
      | "strikethrough"
      | "emphasisMark"
      | "verticalCombine",
    current: boolean,
  ): void => {
    onApplyStyle({ [key]: mode === "visual" ? !current : true });
  };
  return (
    <section
      className="rich-inline-style-panel"
      aria-label={t("editor.richText.inlineStyle", {
        defaultValue: "글자별 서식",
      })}
    >
      <div className="rich-inline-style-grid">
        <div className="rich-inline-emphasis-tools">
          <IconButton
            size="sm"
            label={t("editor.markupToolbar.boldLabel")}
            title={t("editor.markupToolbar.boldTitle")}
            aria-pressed={values.bold}
            disabled={disabled}
            onClick={() => toggle("bold", values.bold)}
          >
            <BoldIcon size={14} />
          </IconButton>
          <IconButton
            size="sm"
            label={t("editor.markupToolbar.italicLabel")}
            title={t("editor.markupToolbar.italicTitle")}
            aria-pressed={values.italic}
            disabled={disabled}
            onClick={() => toggle("italic", values.italic)}
          >
            <ItalicIcon size={14} />
          </IconButton>
          <IconButton
            size="sm"
            label={t("format.blockUnderline")}
            title={t("format.blockUnderline")}
            aria-pressed={values.underline}
            disabled={disabled}
            onClick={() => toggle("underline", values.underline)}
          >
            <UnderlineIcon size={14} />
          </IconButton>
          <IconButton
            size="sm"
            label={t("format.blockStrikethrough")}
            title={t("format.blockStrikethrough")}
            aria-pressed={values.strikethrough}
            disabled={disabled}
            onClick={() => toggle("strikethrough", values.strikethrough)}
          >
            <StrikethroughIcon size={14} />
          </IconButton>
          <IconButton
            size="sm"
            label={t("format.blockEmphasisMark")}
            title={t("format.blockEmphasisMark")}
            aria-pressed={values.emphasisMark}
            disabled={disabled}
            onClick={() => toggle("emphasisMark", values.emphasisMark)}
          >
            <EmphasisMarkIcon size={14} />
          </IconButton>
          <IconButton
            size="sm"
            label={t("editor.richText.combineUpright", {
              defaultValue: "세로 영문 묶음",
            })}
            title={t("editor.richText.combineUpright", {
              defaultValue: "세로 영문 묶음",
            })}
            aria-pressed={values.verticalCombine}
            disabled={disabled}
            onClick={() => toggle("verticalCombine", values.verticalCombine)}
          >
            <span aria-hidden="true" className="rich-inline-tcy-icon">
              縦
            </span>
          </IconButton>
        </div>
        <InlineNumberField
          label={t("editor.richText.size", { defaultValue: "글자 크기" })}
          value={values.sizePx}
          min={MIN_FONT_SIZE_PX}
          max={MAX_FONT_SIZE_PX}
          step={FONT_SIZE_STEP_PX}
          precision={1}
          unit="px"
          mixed={values.sizeMixed}
          disabled={disabled}
          onChange={(sizePx) => onApplyStyle({ sizePx })}
        />
        <InlineNumberField
          label={t("editor.richText.opacity", {
            defaultValue: "글자 투명도",
          })}
          value={values.opacityPercent}
          min={0}
          max={100}
          step={1}
          precision={0}
          unit="%"
          mixed={values.opacityMixed}
          disabled={disabled}
          onChange={(opacity) => onApplyStyle({ opacity: opacity / 100 })}
        />
        <InlineNumberField
          label={t("format.fontWidth")}
          value={values.widthPercent}
          min={MIN_INLINE_WIDTH_PERCENT}
          max={MAX_INLINE_WIDTH_PERCENT}
          step={1}
          precision={0}
          unit="%"
          disabled={disabled}
          onChange={(width) => onApplyStyle({ widthScale: width / 100 })}
        />
        <div className="rich-inline-font-field">
          <span>
            {t("editor.richText.font", { defaultValue: "글자 폰트" })}
            {values.fontMixed ? (
              <small>
                {t("editor.richText.mixed", { defaultValue: "혼합" })}
              </small>
            ) : null}
          </span>
          <FontSelect
            ariaLabel={t("editor.richText.font", {
              defaultValue: "글자 폰트",
            })}
            value={values.fontFamily}
            disabled={disabled}
            onChange={(fontFamily) =>
              onApplyStyle({
                fontFamily:
                  mode === "code" && fontFamily === undefined
                    ? DEFAULT_BLOCK_FONT_ID
                    : (fontFamily ?? null),
              })
            }
          />
        </div>
      </div>
      <div className="editor-appearance-list rich-inline-appearance-list">
        <div className="editor-appearance-row">
          <span className="editor-appearance-label">
            {t("format.textColor")}
          </span>
          <ColorField
            className="editor-appearance-color"
            label={t("format.textColor")}
            labelHidden
            value={values.color}
            disabled={disabled}
            onChange={(color) => onApplyStyle({ color })}
          />
        </div>
        <div className="editor-appearance-row">
          <CheckboxField
            className="editor-appearance-toggle"
            label={t("editor.richText.background", {
              defaultValue: "글자 배경",
            })}
            checked={values.backgroundEnabled}
            disabled={disabled}
            onCheckedChange={(enabled) =>
              onApplyStyle({
                backgroundColor: enabled ? values.backgroundColor : null,
              })
            }
          />
          {values.backgroundEnabled ? (
            <ColorField
              className="editor-appearance-color"
              label={t("format.textBackground.color")}
              labelHidden
              value={values.backgroundColor}
              disabled={disabled}
              onChange={(backgroundColor) => onApplyStyle({ backgroundColor })}
            />
          ) : null}
        </div>
      </div>
      <details className="rich-inline-effects">
        <summary>
          {t("editor.richText.effects", {
            defaultValue: "외곽선 · 광선",
          })}
        </summary>
        <InlineOutlineControls
          disabled={disabled}
          enabled={values.outlineEnabled}
          label={t("format.outline")}
          color={values.outlineColor}
          widthPx={values.outlineWidthPx}
          onEnabledChange={(enabled) =>
            onApplyStyle({
              outlineWidthPx: enabled ? Math.max(values.outlineWidthPx, 1) : 0,
            })
          }
          onColorChange={(outlineColor) => onApplyStyle({ outlineColor })}
          onWidthChange={(outlineWidthPx) => onApplyStyle({ outlineWidthPx })}
        />
        <InlineOutlineControls
          disabled={disabled}
          enabled={values.outerOutlineEnabled}
          label={t("format.outerOutline.enabled")}
          color={values.outerOutlineColor}
          widthPx={values.outerOutlineWidthPx}
          onEnabledChange={(enabled) =>
            onApplyStyle({
              outerOutlineWidthPx: enabled
                ? Math.max(values.outerOutlineWidthPx, 1)
                : 0,
            })
          }
          onColorChange={(outerOutlineColor) =>
            onApplyStyle({ outerOutlineColor })
          }
          onWidthChange={(outerOutlineWidthPx) =>
            onApplyStyle({ outerOutlineWidthPx })
          }
        />
        <div className="rich-inline-effect-row rich-inline-glow-row">
          <CheckboxField
            className="editor-appearance-toggle"
            label={t("format.textGlow.title")}
            checked={values.glowEnabled}
            disabled={disabled}
            onCheckedChange={(enabled) =>
              onApplyStyle({ glowOpacity: enabled ? 0.75 : 0 })
            }
          />
          {values.glowEnabled ? (
            <>
              <ColorField
                className="editor-appearance-color"
                label={t("format.textGlow.color")}
                labelHidden
                value={values.glowColor}
                disabled={disabled}
                onChange={(glowColor) => onApplyStyle({ glowColor })}
              />
              <InlineNumberField
                label={t("format.textGlow.blur")}
                value={values.glowBlurPx}
                min={MIN_TEXT_GLOW_BLUR_PX}
                max={MAX_TEXT_GLOW_BLUR_PX}
                step={1}
                precision={1}
                unit="px"
                disabled={disabled}
                onChange={(glowBlurPx) => onApplyStyle({ glowBlurPx })}
              />
              <InlineNumberField
                label={t("format.textGlow.opacity")}
                value={values.glowOpacityPercent}
                min={0}
                max={100}
                step={1}
                precision={0}
                unit="%"
                disabled={disabled}
                onChange={(opacity) =>
                  onApplyStyle({ glowOpacity: opacity / 100 })
                }
              />
            </>
          ) : null}
        </div>
      </details>
    </section>
  );
}

function InlineOutlineControls({
  color,
  disabled,
  enabled,
  label,
  onColorChange,
  onEnabledChange,
  onWidthChange,
  widthPx,
}: {
  color: string;
  disabled: boolean;
  enabled: boolean;
  label: string;
  onColorChange: (value: string) => void;
  onEnabledChange: (value: boolean) => void;
  onWidthChange: (value: number) => void;
  widthPx: number;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="editor-appearance-row editor-outline-property-row rich-inline-effect-row">
      <CheckboxField
        className="editor-appearance-toggle"
        label={label}
        checked={enabled}
        disabled={disabled}
        onCheckedChange={onEnabledChange}
      />
      {enabled ? (
        <>
          <ColorField
            className="editor-appearance-color"
            label={label}
            labelHidden
            value={color}
            disabled={disabled}
            onChange={onColorChange}
          />
          <div className="rich-inline-outline-width">
            <InlineNumberField
              label={t("gatherText.outlineWidth")}
              labelHidden
              value={widthPx}
              min={MIN_TEXT_OUTLINE_WIDTH_PX}
              max={MAX_TEXT_OUTLINE_WIDTH_PX}
              step={TEXT_OUTLINE_WIDTH_STEP_PX}
              precision={1}
              unit="px"
              disabled={disabled}
              onChange={onWidthChange}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

function InlineNumberField({
  disabled,
  label,
  labelHidden = false,
  max,
  min,
  mixed = false,
  onChange,
  precision,
  step,
  unit,
  value,
}: {
  disabled: boolean;
  label: string;
  labelHidden?: boolean;
  max: number;
  min: number;
  mixed?: boolean;
  onChange: (value: number) => void;
  precision: number;
  step: number;
  unit: string;
  value: number;
}): React.JSX.Element {
  return (
    <label className="rich-inline-number-field">
      <span className={labelHidden ? "visually-hidden" : undefined}>
        {label}
      </span>
      <NumberField
        variant="framed"
        ariaLabel={label}
        value={value}
        min={min}
        max={max}
        step={step}
        precision={precision}
        useTextInput
        selectOnFocus
        unit={unit}
        commitMode="change"
        mixed={mixed}
        placeholder="—"
        disabled={disabled}
        onValueChange={onChange}
      />
    </label>
  );
}

function resolveSelectionValues(
  runs: readonly TextStyleRun[],
  selection: RichTextEditorSelection,
  block: TranslationBlock,
  caretRun: TextStyleRun | null,
  typingStyle: TextStylePatch | null,
): SelectionValues {
  const selected = selectRuns(runs, selection.start, selection.end);
  const candidates =
    selected.length > 0 ? selected : caretRun ? [caretRun] : [];
  const base = createBaseSelectionValues(block);
  if (candidates.length === 0) {
    return applyTypingStyleToValues(base, typingStyle, block);
  }
  const sizes = candidates.map((run) => run.sizePx ?? block.fontSizePx);
  const fonts = candidates.map((run) => run.fontFamily ?? block.fontFamily);
  const opacities = candidates.map(
    (run) => (run.opacity ?? normalizeOpacity(block.textOpacity)) * 100,
  );
  const widths = candidates.map(
    (run) => (run.widthScale ?? block.fontWidthScale ?? 1) * 100,
  );
  const colors = candidates.map(
    (run) => run.color ?? resolveEffectiveTextColor(block),
  );
  const backgrounds = candidates.map((run) => run.backgroundColor);
  const outlineColors = candidates.map(
    (run) => run.outlineColor ?? resolveEffectiveTextOutlineColor(block),
  );
  const outlineWidths = candidates.map(
    (run) =>
      run.outlineWidthPx ??
      resolveEffectiveTextOutlineWidthPx(block, block.fontSizePx),
  );
  const outerOutlineColors = candidates.map(
    (run) => run.outerOutlineColor ?? block.outerOutlineColor ?? "#111111",
  );
  const outerOutlineWidths = candidates.map(
    (run) => run.outerOutlineWidthPx ?? block.outerOutlineWidthPx ?? 0,
  );
  const glows = candidates.map((run) => resolveSelectionGlow(block, run));
  return applyTypingStyleToValues(
    {
      bold: candidates.every((run) => Boolean(block.bold) || run.bold),
      italic: candidates.every((run) => Boolean(block.italic) || run.italic),
      underline: candidates.every(
        (run) => Boolean(block.underline) || run.underline,
      ),
      strikethrough: candidates.every(
        (run) => Boolean(block.strikethrough) || run.strikethrough,
      ),
      emphasisMark: candidates.every(
        (run) => Boolean(block.emphasisMark) || run.emphasisMark,
      ),
      verticalCombine: candidates.every((run) => run.verticalCombine),
      sizePx: sizes[0] ?? block.fontSizePx,
      sizeMixed: !allEqual(sizes),
      fontFamily: fonts[0],
      fontMixed: !allEqual(fonts),
      opacityPercent: opacities[0] ?? normalizeOpacity(block.textOpacity) * 100,
      opacityMixed: !allEqual(opacities),
      widthPercent: widths[0] ?? 100,
      color: colors[0] ?? base.color,
      backgroundEnabled: backgrounds.every(Boolean),
      backgroundColor: backgrounds.find(Boolean) ?? base.backgroundColor,
      outlineEnabled: outlineWidths.every((width) => width > 0),
      outlineColor: outlineColors[0] ?? base.outlineColor,
      outlineWidthPx: outlineWidths[0] ?? 0,
      outerOutlineEnabled: outerOutlineWidths.every((width) => width > 0),
      outerOutlineColor: outerOutlineColors[0] ?? base.outerOutlineColor,
      outerOutlineWidthPx: outerOutlineWidths[0] ?? 0,
      glowEnabled: glows.every((glow) => glow.enabled),
      glowColor: glows[0]?.color ?? base.glowColor,
      glowBlurPx: glows[0]?.blurPx ?? base.glowBlurPx,
      glowOpacityPercent:
        (glows[0]?.opacity ?? base.glowOpacityPercent / 100) * 100,
    },
    typingStyle,
    block,
  );
}

function createBaseSelectionValues(block: TranslationBlock): SelectionValues {
  const glow = resolveTextGlow(block.textGlow);
  return {
    bold: Boolean(block.bold),
    italic: Boolean(block.italic),
    underline: Boolean(block.underline),
    strikethrough: Boolean(block.strikethrough),
    emphasisMark: Boolean(block.emphasisMark),
    verticalCombine: false,
    sizePx: block.fontSizePx,
    sizeMixed: false,
    fontFamily: block.fontFamily,
    fontMixed: false,
    opacityPercent: normalizeOpacity(block.textOpacity) * 100,
    opacityMixed: false,
    widthPercent: (block.fontWidthScale ?? 1) * 100,
    color: resolveEffectiveTextColor(block),
    backgroundEnabled: false,
    backgroundColor: "#ffffff",
    outlineEnabled:
      resolveEffectiveTextOutlineWidthPx(block, block.fontSizePx) > 0,
    outlineColor: resolveEffectiveTextOutlineColor(block),
    outlineWidthPx: resolveEffectiveTextOutlineWidthPx(block, block.fontSizePx),
    outerOutlineEnabled: (block.outerOutlineWidthPx ?? 0) > 0,
    outerOutlineColor: block.outerOutlineColor ?? "#111111",
    outerOutlineWidthPx: block.outerOutlineWidthPx ?? 0,
    glowEnabled: glow.enabled,
    glowColor: glow.color,
    glowBlurPx: glow.blurPx,
    glowOpacityPercent: glow.opacity * 100,
  };
}

function resolveSelectionGlow(
  block: TranslationBlock,
  run: TextStyleRun,
): { enabled: boolean; color: string; blurPx: number; opacity: number } {
  const base = resolveTextGlow(block.textGlow);
  const hasInline =
    run.glowColor !== undefined ||
    run.glowBlurPx !== undefined ||
    run.glowOpacity !== undefined;
  const opacity = hasInline
    ? (run.glowOpacity ?? base.opacity)
    : base.enabled
      ? base.opacity
      : 0;
  return {
    enabled: opacity > 0,
    color: run.glowColor ?? base.color,
    blurPx: run.glowBlurPx ?? base.blurPx,
    opacity,
  };
}

function selectRuns(
  runs: readonly TextStyleRun[],
  start: number,
  end: number,
): TextStyleRun[] {
  if (end <= start) return [];
  const selected: TextStyleRun[] = [];
  let offset = 0;
  for (const run of runs) {
    const runEnd = offset + run.text.length;
    if (Math.max(start, offset) < Math.min(end, runEnd)) selected.push(run);
    offset = runEnd;
  }
  return selected;
}

function applyTypingStyleToValues(
  values: SelectionValues,
  patch: TextStylePatch | null,
  block: TranslationBlock,
): SelectionValues {
  if (!patch) return values;
  const fallback = createBaseSelectionValues(block);
  const next: SelectionValues = {
    ...values,
    ...(patch.bold === undefined
      ? {}
      : { bold: patch.bold ?? Boolean(block.bold) }),
    ...(patch.italic === undefined
      ? {}
      : { italic: patch.italic ?? Boolean(block.italic) }),
    ...(patch.underline === undefined
      ? {}
      : { underline: patch.underline ?? fallback.underline }),
    ...(patch.strikethrough === undefined
      ? {}
      : { strikethrough: patch.strikethrough ?? fallback.strikethrough }),
    ...(patch.emphasisMark === undefined
      ? {}
      : { emphasisMark: patch.emphasisMark ?? fallback.emphasisMark }),
    ...(patch.verticalCombine === undefined
      ? {}
      : { verticalCombine: patch.verticalCombine ?? false }),
    ...(patch.sizePx === undefined
      ? {}
      : { sizePx: patch.sizePx ?? block.fontSizePx, sizeMixed: false }),
    ...(patch.fontFamily === undefined
      ? {}
      : {
          fontFamily: patch.fontFamily ?? block.fontFamily,
          fontMixed: false,
        }),
    ...(patch.opacity === undefined
      ? {}
      : {
          opacityPercent:
            (patch.opacity ?? normalizeOpacity(block.textOpacity)) * 100,
          opacityMixed: false,
        }),
    ...(patch.widthScale === undefined
      ? {}
      : {
          widthPercent: (patch.widthScale ?? block.fontWidthScale ?? 1) * 100,
        }),
    ...(patch.color === undefined
      ? {}
      : { color: patch.color ?? fallback.color }),
    ...(patch.backgroundColor === undefined
      ? {}
      : {
          backgroundEnabled: patch.backgroundColor !== null,
          backgroundColor: patch.backgroundColor ?? fallback.backgroundColor,
        }),
    ...(patch.outlineColor === undefined
      ? {}
      : { outlineColor: patch.outlineColor ?? fallback.outlineColor }),
    ...(patch.outlineWidthPx === undefined
      ? {}
      : {
          outlineEnabled: (patch.outlineWidthPx ?? fallback.outlineWidthPx) > 0,
          outlineWidthPx: patch.outlineWidthPx ?? fallback.outlineWidthPx,
        }),
    ...(patch.outerOutlineColor === undefined
      ? {}
      : {
          outerOutlineColor:
            patch.outerOutlineColor ?? fallback.outerOutlineColor,
        }),
    ...(patch.outerOutlineWidthPx === undefined
      ? {}
      : {
          outerOutlineEnabled:
            (patch.outerOutlineWidthPx ?? fallback.outerOutlineWidthPx) > 0,
          outerOutlineWidthPx:
            patch.outerOutlineWidthPx ?? fallback.outerOutlineWidthPx,
        }),
    ...(patch.glowColor === undefined
      ? {}
      : { glowColor: patch.glowColor ?? fallback.glowColor }),
    ...(patch.glowBlurPx === undefined
      ? {}
      : { glowBlurPx: patch.glowBlurPx ?? fallback.glowBlurPx }),
    ...(patch.glowOpacity === undefined
      ? {}
      : {
          glowEnabled:
            (patch.glowOpacity ?? fallback.glowOpacityPercent / 100) > 0,
          glowOpacityPercent:
            (patch.glowOpacity ?? fallback.glowOpacityPercent / 100) * 100,
        }),
  };
  return next;
}

function allEqual<T>(values: readonly T[]): boolean {
  return values.every((value) => Object.is(value, values[0]));
}

function normalizeOpacity(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value as number));
}

function formatNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}

function nextSelectionToResult(selection: RichTextEditorSelection): {
  selectionStart: number;
  selectionEnd: number;
} {
  return {
    selectionStart: selection.start,
    selectionEnd: selection.end,
  };
}

function readStoredMode(): EditorMode {
  if (typeof window === "undefined") return "visual";
  return window.localStorage.getItem(EDITOR_MODE_STORAGE_KEY) === "code"
    ? "code"
    : "visual";
}
