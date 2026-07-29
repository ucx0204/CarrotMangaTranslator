import React from "react";
import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import { useStickyTextareaHeight } from "../hooks/useStickyTextareaHeight";
import { applyInlineMarkup } from "../lib/textareaMarkup";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { BoldIcon, ItalicIcon, RestoreIcon } from "./ui/icons";

type BlockPatchHandler = (patch: Partial<TranslationBlock>) => void;

type BlockSectionProps = {
  block: TranslationBlock;
  disabled: boolean;
  onUpdate: BlockPatchHandler;
};

type BlockTextActionProps = {
  onEraseOriginal?: () => void;
  onFitBubble?: () => void;
};

export function BubbleLayoutOption({
  disabled,
  onRemove,
}: {
  disabled: boolean;
  onRemove: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="editor-bubble-layout-status">
      <strong role="status">
        {t("editor.bubbleLayout.active", {
          defaultValue: "말풍선 맞춤 적용됨",
        })}
      </strong>
      <Button
        size="sm"
        variant="secondary"
        iconLeft={<RestoreIcon size={15} />}
        disabled={disabled}
        onClick={onRemove}
      >
        {t("editor.bubbleLayout.remove")}
      </Button>
    </div>
  );
}

export function TextEditorGroup({
  block,
  disabled,
  onEraseOriginal,
  onFitBubble,
  onUpdate,
}: BlockSectionProps & BlockTextActionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const { refCallback: translatedTextareaRef, reset: resetTranslatedHeight } =
    useStickyTextareaHeight("editor.textareaHeight.translated");
  const { refCallback: sourceTextareaRef, reset: resetSourceHeight } =
    useStickyTextareaHeight("editor.textareaHeight.source");
  const translatedRef = React.useRef<HTMLTextAreaElement | null>(null);
  const sourceRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const markupHelpId = React.useId();
  const drafts = useBlockTextDrafts(block, onUpdate, translatedRef, sourceRef);
  const setTranslatedRef = React.useCallback(
    (element: HTMLTextAreaElement | null) => {
      translatedRef.current = element;
      translatedTextareaRef(element);
    },
    [translatedTextareaRef],
  );
  const setSourceRef = React.useCallback(
    (element: HTMLTextAreaElement | null) => {
      sourceRef.current = element;
      sourceTextareaRef(element);
    },
    [sourceTextareaRef],
  );
  const resetTextareaHeights = React.useCallback(() => {
    resetTranslatedHeight();
    resetSourceHeight();
  }, [resetTranslatedHeight, resetSourceHeight]);

  return (
    <div className="editor-group editor-text-group">
      <TextBlockActions {...{ disabled, onEraseOriginal, onFitBubble }} />
      <div className="editor-group-head">
        <h3>{t("editor.translatedText")}</h3>
        <TextMarkupToolbar
          disabled={disabled}
          helpId={markupHelpId}
          helpOpen={helpOpen}
          onWrap={drafts.wrapTranslatedSelection}
          onResetHeights={resetTextareaHeights}
          onToggleHelp={() => setHelpOpen((open) => !open)}
        />
      </div>
      <textarea
        ref={setTranslatedRef}
        aria-label={t("editor.translatedText")}
        value={drafts.translated}
        disabled={disabled}
        onChange={(event) => drafts.changeTranslated(event.target.value)}
      />
      {helpOpen ? (
        <p className="muted-line markup-hint" id={markupHelpId}>
          {t("editor.markupHint.emphasis")} <code>**{t("format.bold")}**</code>,{" "}
          <code>*{t("format.italicShort")}*</code> ·{" "}
          {t("editor.markupHint.escape")} <code>\*</code>
        </p>
      ) : null}
      <SourceTextField
        disabled={disabled}
        refCallback={setSourceRef}
        value={drafts.source}
        onChange={drafts.changeSource}
      />
    </div>
  );
}

function TextBlockActions({
  disabled,
  onEraseOriginal,
  onFitBubble,
}: { disabled: boolean } & BlockTextActionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="editor-text-actions">
      <Button fullWidth size="sm" disabled={disabled} onClick={onEraseOriginal}>
        {t("editor.eraseOriginal")}
      </Button>
      <Button fullWidth size="sm" disabled={disabled} onClick={onFitBubble}>
        {t("editor.fitBubble")}
      </Button>
    </div>
  );
}

function SourceTextField({
  disabled,
  refCallback,
  value,
  onChange,
}: {
  disabled: boolean;
  refCallback: (element: HTMLTextAreaElement | null) => void;
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <label className="editor-source-field">
      <span>OCR</span>
      <textarea
        ref={refCallback}
        aria-label="OCR"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

/**
 * Local, optimistic text state for the editor textareas so typing stays instant
 * and cursor-stable even when updates round-trip through the panel bridge (in a
 * popped-out window). Upstream values re-sync on block switch, or on external
 * edits while the field is not focused — never clobbering an active edit.
 */
function useBlockTextDrafts(
  block: TranslationBlock,
  onUpdate: BlockPatchHandler,
  translatedRef: React.RefObject<HTMLTextAreaElement | null>,
  sourceRef: React.RefObject<HTMLTextAreaElement | null>,
): {
  translated: string;
  source: string;
  changeTranslated: (value: string) => void;
  changeSource: (value: string) => void;
  wrapTranslatedSelection: (marker: string) => void;
} {
  const [translated, setTranslated] = React.useState(block.translatedText);
  const [source, setSource] = React.useState(block.sourceText);
  const blockIdRef = React.useRef(block.id);
  const selectionFrameRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const switched = blockIdRef.current !== block.id;
    blockIdRef.current = block.id;
    if (switched || document.activeElement !== translatedRef.current) {
      setTranslated(block.translatedText);
    }
    if (switched || document.activeElement !== sourceRef.current) {
      setSource(block.sourceText);
    }
  }, [
    block.id,
    block.translatedText,
    block.sourceText,
    translatedRef,
    sourceRef,
  ]);
  React.useEffect(
    () => () => {
      if (selectionFrameRef.current !== null) {
        cancelAnimationFrame(selectionFrameRef.current);
      }
    },
    [],
  );

  const changeTranslated = (value: string): void => {
    setTranslated(value);
    React.startTransition(() => onUpdate({ translatedText: value }));
  };
  const changeSource = (value: string): void => {
    setSource(value);
    React.startTransition(() => onUpdate({ sourceText: value }));
  };
  const wrapTranslatedSelection = (marker: string): void => {
    const element = translatedRef.current;
    if (!element) {
      return;
    }
    const result = applyInlineMarkup(
      element.value,
      element.selectionStart ?? element.value.length,
      element.selectionEnd ?? element.value.length,
      marker,
    );
    changeTranslated(result.value);
    if (selectionFrameRef.current !== null) {
      cancelAnimationFrame(selectionFrameRef.current);
    }
    selectionFrameRef.current = requestAnimationFrame(() => {
      selectionFrameRef.current = null;
      if (!element.isConnected) return;
      element.focus();
      element.setSelectionRange(result.selectionStart, result.selectionEnd);
    });
  };

  return {
    translated,
    source,
    changeTranslated,
    changeSource,
    wrapTranslatedSelection,
  };
}

function TextMarkupToolbar({
  disabled,
  helpId,
  helpOpen,
  onWrap,
  onResetHeights,
  onToggleHelp,
}: {
  disabled: boolean;
  helpId: string;
  helpOpen: boolean;
  onWrap: (marker: string) => void;
  onResetHeights: () => void;
  onToggleHelp: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="editor-inline-toolbar">
      <span>{t("editor.markupHint.emphasis")}</span>
      <div className="block-style-group">
        <IconButton
          size="sm"
          label={t("editor.markupToolbar.boldLabel")}
          title={t("editor.markupToolbar.boldTitle")}
          disabled={disabled}
          onClick={() => onWrap("**")}
        >
          <BoldIcon size={14} />
        </IconButton>
        <IconButton
          size="sm"
          label={t("editor.markupToolbar.italicLabel")}
          title={t("editor.markupToolbar.italicTitle")}
          disabled={disabled}
          onClick={() => onWrap("*")}
        >
          <ItalicIcon size={14} />
        </IconButton>
        <IconButton
          size="sm"
          label={t("editor.markupToolbar.resetHeight")}
          title={t("editor.markupToolbar.resetHeight")}
          onClick={onResetHeights}
        >
          <RestoreIcon size={14} />
        </IconButton>
        <IconButton
          size="sm"
          label={t("editor.markupToolbar.help", {
            defaultValue: "부분 강조 도움말",
          })}
          aria-controls={helpId}
          aria-expanded={helpOpen}
          onClick={onToggleHelp}
        >
          <span aria-hidden="true">?</span>
        </IconButton>
      </div>
    </div>
  );
}
