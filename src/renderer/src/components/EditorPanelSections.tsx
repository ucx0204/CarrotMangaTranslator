import React from "react";
import { IconEraserOff } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import { ColorField } from "./ColorField";
import { useStickyTextareaHeight } from "../hooks/useStickyTextareaHeight";
import { applyInlineMarkup } from "../lib/textareaMarkup";
import { Button } from "./ui/Button";
import { FieldSlider } from "./ui/FieldSlider";
import { IconButton } from "./ui/IconButton";
import {
  BoldIcon,
  CopyIcon,
  ItalicIcon,
  RestoreIcon,
  TrashIcon,
} from "./ui/icons";
import { resolveColor, type EditorPanelModel } from "./editorPanelUtils";
import type { BlockBackgroundApplyScope } from "../hooks/useBlockEditingActions";
import { BlockBackgroundApplyModal } from "./BlockBackgroundApplyModal";

type BlockPatchHandler = (patch: Partial<TranslationBlock>) => void;

type BlockSectionProps = {
  block: TranslationBlock;
  disabled: boolean;
  onUpdate: BlockPatchHandler;
};

export function InpaintingBlockOption({
  block,
  disabled,
  onUpdate,
}: BlockSectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="editor-inpainting-group">
      <label className="editor-inpainting-option">
        <IconEraserOff size={19} stroke={2.1} aria-hidden="true" />
        <strong>{t("editor.inpainting.exclude")}</strong>
        <input
          type="checkbox"
          checked={Boolean(block.inpaintExcluded)}
          disabled={disabled}
          onChange={(event) =>
            onUpdate({ inpaintExcluded: event.target.checked })
          }
        />
      </label>
    </div>
  );
}

export function EmptyEditorPanel({
  areaTranslateAvailable,
  areaTranslateSelecting,
  disabled,
  headerActions,
  onStartAreaTranslate,
}: {
  areaTranslateAvailable: boolean;
  areaTranslateSelecting: boolean;
  disabled: boolean;
  headerActions?: React.ReactNode;
  onStartAreaTranslate?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="editor-panel muted">
      <header className="editor-panel-header">
        <h2>{t("common.blocks")}</h2>
        {headerActions ? (
          <div className="editor-panel-header-actions">{headerActions}</div>
        ) : null}
      </header>
      <button
        className={`area-translate-button ${areaTranslateSelecting ? "active" : ""}`}
        disabled={disabled || !areaTranslateAvailable}
        onClick={onStartAreaTranslate}
      >
        {t(
          areaTranslateSelecting
            ? "areaTranslation.cancelSelection"
            : "areaTranslation.title",
        )}
      </button>
    </section>
  );
}

export function TextEditorGroup({
  block,
  disabled,
  onUpdate,
}: BlockSectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const { refCallback: translatedTextareaRef, reset: resetTranslatedHeight } =
    useStickyTextareaHeight("editor.textareaHeight.translated");
  const { refCallback: sourceTextareaRef, reset: resetSourceHeight } =
    useStickyTextareaHeight("editor.textareaHeight.source");
  const translatedRef = React.useRef<HTMLTextAreaElement | null>(null);
  const sourceRef = React.useRef<HTMLTextAreaElement | null>(null);
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
    <div className="editor-group">
      <div className="editor-group-head">
        <h3>{t("editor.text")}</h3>
        <TextMarkupToolbar
          disabled={disabled}
          onWrap={drafts.wrapTranslatedSelection}
          onResetHeights={resetTextareaHeights}
        />
      </div>
      <label>
        {t("editor.translatedText")}
        <textarea
          ref={setTranslatedRef}
          value={drafts.translated}
          disabled={disabled}
          onChange={(event) => drafts.changeTranslated(event.target.value)}
        />
      </label>
      <p className="muted-line markup-hint">
        {t("editor.markupHint.emphasis")} <code>**{t("format.bold")}**</code>,{" "}
        <code>*{t("format.italicShort")}*</code> ·{" "}
        {t("editor.markupHint.escape")} <code>\*</code>
      </p>
      <label>
        OCR
        <textarea
          ref={setSourceRef}
          value={drafts.source}
          disabled={disabled}
          onChange={(event) => drafts.changeSource(event.target.value)}
        />
      </label>
    </div>
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

  const changeTranslated = (value: string): void => {
    setTranslated(value);
    onUpdate({ translatedText: value });
  };
  const changeSource = (value: string): void => {
    setSource(value);
    onUpdate({ sourceText: value });
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
    requestAnimationFrame(() => {
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
  onWrap,
  onResetHeights,
}: {
  disabled: boolean;
  onWrap: (marker: string) => void;
  onResetHeights: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
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
    </div>
  );
}

export function ColorEditorGroup({
  block,
  disabled,
  model,
  onUpdate,
}: BlockSectionProps & {
  model: EditorPanelModel;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="editor-group">
      <div className="editor-group-head">
        <h3>{t("format.color")}</h3>
      </div>
      <div className="color-row" aria-label={t("editor.blockColors")}>
        <ColorField
          label={t("format.textColor")}
          value={resolveColor(block.textColor, "#111111")}
          disabled={disabled}
          onChange={(textColor) => onUpdate({ textColor })}
        />
        <ColorField
          label={t("format.outline")}
          value={model.outlineColor}
          disabled={disabled}
          onChange={(outlineColor) => onUpdate({ outlineColor })}
        />
      </div>
      <FieldSlider
        label={t("format.outline")}
        valueLabel={`${Math.round((block.outlineWidthScale ?? 1) * 100)}%`}
        min={0}
        max={2.5}
        step={0.1}
        value={block.outlineWidthScale ?? 1}
        disabled={disabled}
        onChange={(event) =>
          onUpdate({ outlineWidthScale: Number(event.target.value) })
        }
      />
    </div>
  );
}

export function BlockDisplayGroup({
  block,
  disabled,
  disableChapterApply,
  onApply,
  onUpdate,
}: BlockSectionProps & {
  disableChapterApply: boolean;
  onApply?: (scope: BlockBackgroundApplyScope) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const [batchOpen, setBatchOpen] = React.useState(false);
  return (
    <div className="editor-group editor-display-group">
      <div className="editor-group-head">
        <h3>{t("editor.display.title")}</h3>
        {onApply ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => setBatchOpen(true)}
          >
            {t("editor.display.batchApply")}
          </Button>
        ) : null}
      </div>
      <FieldSlider
        label={t("format.blockBackgroundOpacity")}
        valueLabel={`${Math.round(block.opacity * 100)}%`}
        min={0}
        max={1}
        step={0.01}
        value={block.opacity}
        disabled={disabled}
        onChange={(event) => onUpdate({ opacity: Number(event.target.value) })}
      />
      {batchOpen && onApply ? (
        <BlockBackgroundApplyModal
          disableChapterApply={disableChapterApply}
          onApply={onApply}
          onClose={() => setBatchOpen(false)}
        />
      ) : null}
    </div>
  );
}

export function BlockActionButtons({
  disabled,
  onDelete,
  onDuplicate,
}: {
  disabled: boolean;
  onDelete: () => void;
  onDuplicate: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="block-actions">
      <Button
        fullWidth
        iconLeft={<CopyIcon size={15} />}
        onClick={onDuplicate}
        disabled={disabled}
      >
        {t("common.duplicate")}
      </Button>
      <Button
        variant="danger"
        fullWidth
        iconLeft={<TrashIcon size={15} />}
        onClick={onDelete}
        disabled={disabled}
      >
        {t("common.delete")}
      </Button>
    </div>
  );
}
