import React from "react";
import type { TranslationBlock } from "../../../shared/textTypes";
import { ColorField } from "./ColorField";
import { useStickyTextareaHeight } from "../hooks/useStickyTextareaHeight";
import { applyInlineMarkup } from "../lib/textareaMarkup";
import { Button, FieldSlider, IconButton } from "./ui";
import {
  BoldIcon,
  CopyIcon,
  ItalicIcon,
  RestoreIcon,
  TrashIcon,
} from "./ui/icons";
import { resolveColor, type EditorPanelModel } from "./editorPanelUtils";

type BlockPatchHandler = (patch: Partial<TranslationBlock>) => void;

type BlockSectionProps = {
  block: TranslationBlock;
  disabled: boolean;
  onUpdate: BlockPatchHandler;
};

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
  return (
    <section className="editor-panel muted">
      <header className="editor-panel-header">
        <h2>블록</h2>
        {headerActions ? (
          <div className="editor-panel-header-actions">{headerActions}</div>
        ) : null}
      </header>
      <button
        className={`area-translate-button ${areaTranslateSelecting ? "active" : ""}`}
        disabled={disabled || !areaTranslateAvailable}
        onClick={onStartAreaTranslate}
      >
        {areaTranslateSelecting ? "선택 취소" : "영역 번역"}
      </button>
    </section>
  );
}

export function TextEditorGroup({
  block,
  disabled,
  onUpdate,
}: BlockSectionProps): React.JSX.Element {
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
        <h3>텍스트</h3>
        <TextMarkupToolbar
          disabled={disabled}
          onWrap={drafts.wrapTranslatedSelection}
          onResetHeights={resetTextareaHeights}
        />
      </div>
      <label>
        한국어
        <textarea
          ref={setTranslatedRef}
          value={drafts.translated}
          disabled={disabled}
          onChange={(event) => drafts.changeTranslated(event.target.value)}
        />
      </label>
      <p className="muted-line markup-hint">
        일부 강조: <code>**굵게**</code>, <code>*기울임*</code> · 별표 문자는{" "}
        <code>\*</code>
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
  return (
    <div className="block-style-group">
      <IconButton
        size="sm"
        label="굵게 (**굵게**)"
        title="선택한 글자를 굵게 (**굵게**)"
        disabled={disabled}
        onClick={() => onWrap("**")}
      >
        <BoldIcon size={14} />
      </IconButton>
      <IconButton
        size="sm"
        label="기울임 (*기울임*)"
        title="선택한 글자를 기울임 (*기울임*)"
        disabled={disabled}
        onClick={() => onWrap("*")}
      >
        <ItalicIcon size={14} />
      </IconButton>
      <IconButton
        size="sm"
        label="입력칸 높이 초기화"
        title="입력칸 높이 초기화"
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
  return (
    <div className="editor-group">
      <div className="editor-group-head">
        <h3>색상</h3>
      </div>
      <div className="color-row" aria-label="블록 색상">
        <ColorField
          label="글자색"
          value={resolveColor(block.textColor, "#111111")}
          disabled={disabled}
          onChange={(textColor) => onUpdate({ textColor })}
        />
        <ColorField
          label="외곽선"
          value={model.outlineColor}
          disabled={disabled}
          onChange={(outlineColor) => onUpdate({ outlineColor })}
        />
      </div>
      <FieldSlider
        label="외곽선"
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

export function BlockActionButtons({
  disabled,
  onDelete,
  onDuplicate,
}: {
  disabled: boolean;
  onDelete: () => void;
  onDuplicate: () => void;
}): React.JSX.Element {
  return (
    <div className="block-actions">
      <Button
        fullWidth
        iconLeft={<CopyIcon size={15} />}
        onClick={onDuplicate}
        disabled={disabled}
      >
        복제
      </Button>
      <Button
        variant="danger"
        fullWidth
        iconLeft={<TrashIcon size={15} />}
        onClick={onDelete}
        disabled={disabled}
      >
        삭제
      </Button>
    </div>
  );
}
