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
  applyInlineMarkup,
  applyInlineStyleTag,
  type InlineMarkupResult,
} from "../lib/textareaMarkup";
import { resolveBlockFontFamily } from "../lib/fonts";
import { IconButton } from "./ui/IconButton";
import { NumberField } from "./ui/NumberField";
import {
  BoldIcon,
  CodeIcon,
  ItalicIcon,
  RestoreIcon,
  TypeStyleIcon,
} from "./ui/icons";
import { FontSelect } from "./FontSelect";

type EditorMode = "visual" | "code";

type RichTranslationEditorProps = {
  block: TranslationBlock;
  disabled: boolean;
  editorRootRef: React.RefObject<HTMLDivElement | null>;
  heightRefCallback: (element: HTMLElement | null) => void;
  onChange: (value: string) => void;
  value: string;
};

const EDITOR_MODE_STORAGE_KEY = "editor.richText.mode";

export function RichTranslationEditor({
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
  const selectionFrameRef = React.useRef<number | null>(null);
  const parsed = React.useMemo(() => parseRichText(value), [value]);

  const renderOptions = React.useMemo<RichTextEditorRenderOptions>(
    () => ({
      baseBold: Boolean(block.bold),
      baseItalic: Boolean(block.italic),
      baseFontSizePx: block.fontSizePx,
      baseFontFamily: resolveBlockFontFamily(block.fontFamily, catalog),
      baseOpacity: normalizeOpacity(block.textOpacity),
      resolveFontFamily: (fontId) =>
        resolveBlockFontFamily(fontId ?? block.fontFamily, catalog),
    }),
    [
      block.bold,
      block.fontFamily,
      block.fontSizePx,
      block.italic,
      block.textOpacity,
      catalog,
    ],
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
  }, [block.id, clearTypingStyle]);

  React.useEffect(
    () => () => {
      if (selectionFrameRef.current !== null) {
        cancelAnimationFrame(selectionFrameRef.current);
      }
    },
    [],
  );

  const setEditorMode = (next: EditorMode): void => {
    setMode(next);
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
    onChange(result.value);
    setSelection({
      start: result.selectionStart,
      end: result.selectionEnd,
    });
    if (selectionFrameRef.current !== null) {
      cancelAnimationFrame(selectionFrameRef.current);
    }
    selectionFrameRef.current = requestAnimationFrame(() => {
      selectionFrameRef.current = null;
      const element = codeRef.current;
      if (!element) return;
      element.setSelectionRange(result.selectionStart, result.selectionEnd);
    });
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
    }
  };

  const toggleBold = (): void => {
    applyInlineStyle({
      bold: mode === "visual" ? !selectionValues.bold : true,
    });
  };
  const toggleItalic = (): void => {
    applyInlineStyle({
      italic: mode === "visual" ? !selectionValues.italic : true,
    });
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

      <InlineStylePanel
        disabled={disabled}
        values={selectionValues}
        onToggleBold={toggleBold}
        onToggleItalic={toggleItalic}
        onFontChange={(fontFamily) =>
          applyInlineStyle({
            fontFamily:
              mode === "code" && fontFamily === undefined
                ? DEFAULT_BLOCK_FONT_ID
                : (fontFamily ?? null),
          })
        }
        onOpacityChange={(percent) =>
          applyInlineStyle({ opacity: percent / 100 })
        }
        onSizeChange={(sizePx) => applyInlineStyle({ sizePx })}
      />

      {mode === "visual" ? (
        <div
          ref={(element) => {
            visualRef.current = element;
            heightRefCallback(element);
          }}
          className="rich-editor-surface"
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
    </div>
  );
}

type SelectionValues = {
  bold: boolean;
  italic: boolean;
  sizePx: number;
  sizeMixed: boolean;
  fontFamily: string | undefined;
  fontMixed: boolean;
  opacityPercent: number;
  opacityMixed: boolean;
};

function InlineStylePanel({
  disabled,
  values,
  onFontChange,
  onOpacityChange,
  onSizeChange,
  onToggleBold,
  onToggleItalic,
}: {
  disabled: boolean;
  values: SelectionValues;
  onFontChange: (fontFamily: string | undefined) => void;
  onOpacityChange: (value: number) => void;
  onSizeChange: (value: number) => void;
  onToggleBold: () => void;
  onToggleItalic: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section
      className="rich-inline-style-panel"
      aria-label={t("editor.richText.inlineStyle", {
        defaultValue: "글자별 서식",
      })}
    >
      <div className="rich-inline-style-grid">
        <label>
          <span>
            {t("editor.richText.size", { defaultValue: "글자 크기" })}
          </span>
          <div className="rich-inline-number-field">
            <NumberField
              ariaLabel={t("editor.richText.size", {
                defaultValue: "글자 크기",
              })}
              value={values.sizePx}
              min={MIN_FONT_SIZE_PX}
              max={MAX_FONT_SIZE_PX}
              step={FONT_SIZE_STEP_PX}
              precision={1}
              snapToStep
              useTextInput
              selectOnFocus
              className="rich-inline-number-input"
              commitMode="change"
              mixed={values.sizeMixed}
              placeholder="—"
              disabled={disabled}
              onValueChange={onSizeChange}
            />
            <span>px</span>
          </div>
        </label>
        <label>
          <span>
            {t("editor.richText.opacity", { defaultValue: "글자 투명도" })}
          </span>
          <div className="rich-inline-number-field">
            <NumberField
              ariaLabel={t("editor.richText.opacity", {
                defaultValue: "글자 투명도",
              })}
              value={values.opacityPercent}
              min={0}
              max={100}
              step={1}
              precision={0}
              inputMode="numeric"
              useTextInput
              selectOnFocus
              className="rich-inline-number-input"
              commitMode="change"
              mixed={values.opacityMixed}
              placeholder="—"
              disabled={disabled}
              onValueChange={onOpacityChange}
            />
            <span>%</span>
          </div>
        </label>
        <div className="rich-inline-emphasis-tools">
          <IconButton
            size="sm"
            label={t("editor.markupToolbar.boldLabel")}
            title={t("editor.markupToolbar.boldTitle")}
            aria-pressed={values.bold}
            disabled={disabled}
            onClick={onToggleBold}
          >
            <BoldIcon size={14} />
          </IconButton>
          <IconButton
            size="sm"
            label={t("editor.markupToolbar.italicLabel")}
            title={t("editor.markupToolbar.italicTitle")}
            aria-pressed={values.italic}
            disabled={disabled}
            onClick={onToggleItalic}
          >
            <ItalicIcon size={14} />
          </IconButton>
        </div>
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
            onChange={onFontChange}
          />
        </div>
      </div>
    </section>
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
  if (candidates.length === 0) {
    return applyTypingStyleToValues(
      {
        bold: Boolean(block.bold),
        italic: Boolean(block.italic),
        sizePx: block.fontSizePx,
        sizeMixed: false,
        fontFamily: block.fontFamily,
        fontMixed: false,
        opacityPercent: normalizeOpacity(block.textOpacity) * 100,
        opacityMixed: false,
      },
      typingStyle,
      block,
    );
  }
  const sizes = candidates.map((run) => run.sizePx ?? block.fontSizePx);
  const fonts = candidates.map((run) => run.fontFamily ?? block.fontFamily);
  const opacities = candidates.map(
    (run) => (run.opacity ?? normalizeOpacity(block.textOpacity)) * 100,
  );
  return applyTypingStyleToValues(
    {
      bold: candidates.every((run) => Boolean(block.bold) || run.bold),
      italic: candidates.every((run) => Boolean(block.italic) || run.italic),
      sizePx: sizes[0] ?? block.fontSizePx,
      sizeMixed: !allEqual(sizes),
      fontFamily: fonts[0],
      fontMixed: !allEqual(fonts),
      opacityPercent: opacities[0] ?? normalizeOpacity(block.textOpacity) * 100,
      opacityMixed: !allEqual(opacities),
    },
    typingStyle,
    block,
  );
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
  return {
    ...values,
    ...(patch.bold === undefined
      ? {}
      : { bold: patch.bold ?? Boolean(block.bold) }),
    ...(patch.italic === undefined
      ? {}
      : { italic: patch.italic ?? Boolean(block.italic) }),
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
  };
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
