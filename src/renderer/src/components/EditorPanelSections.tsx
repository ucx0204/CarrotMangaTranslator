import React from "react";
import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import { useStickyTextareaHeight } from "../hooks/useStickyTextareaHeight";
import { Button } from "./ui/Button";
import { RestoreIcon, TextareaHeightIcon } from "./ui/icons";
import { RichTranslationEditor } from "./RichTranslationEditor";

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
  const { refCallback: translatedTextareaRef, reset: resetTranslatedHeight } =
    useStickyTextareaHeight("editor.textareaHeight.translated");
  const { refCallback: sourceTextareaRef, reset: resetSourceHeight } =
    useStickyTextareaHeight("editor.textareaHeight.source");
  const translatedEditorRootRef = React.useRef<HTMLDivElement | null>(null);
  const sourceRef = React.useRef<HTMLTextAreaElement | null>(null);
  const drafts = useBlockTextDrafts(
    block,
    onUpdate,
    translatedEditorRootRef,
    sourceRef,
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
      <RichTranslationEditor
        block={block}
        value={drafts.translated}
        disabled={disabled}
        editorRootRef={translatedEditorRootRef}
        heightRefCallback={translatedTextareaRef}
        onChange={drafts.changeTranslated}
      />
      <SourceTextField
        disabled={disabled}
        refCallback={setSourceRef}
        onResetHeights={resetTextareaHeights}
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
  if (!onEraseOriginal && !onFitBubble) return <></>;
  return (
    <div className="editor-text-actions">
      {onEraseOriginal ? (
        <Button
          fullWidth
          size="sm"
          disabled={disabled}
          onClick={onEraseOriginal}
        >
          {t("editor.eraseOriginal")}
        </Button>
      ) : null}
      {onFitBubble ? (
        <Button fullWidth size="sm" disabled={disabled} onClick={onFitBubble}>
          {t("editor.fitBubble")}
        </Button>
      ) : null}
    </div>
  );
}

function SourceTextField({
  disabled,
  refCallback,
  value,
  onChange,
  onResetHeights,
}: {
  disabled: boolean;
  refCallback: (element: HTMLTextAreaElement | null) => void;
  value: string;
  onChange: (value: string) => void;
  onResetHeights: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="editor-source-field">
      <span className="editor-source-field-head">
        <span>OCR</span>
        <Button
          size="sm"
          variant="secondary"
          iconLeft={<TextareaHeightIcon size={14} />}
          onClick={onResetHeights}
        >
          {t("editor.markupToolbar.resetHeight")}
        </Button>
      </span>
      <textarea
        ref={refCallback}
        aria-label="OCR"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
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
  translatedEditorRootRef: React.RefObject<HTMLDivElement | null>,
  sourceRef: React.RefObject<HTMLTextAreaElement | null>,
): {
  translated: string;
  source: string;
  changeTranslated: (value: string) => void;
  changeSource: (value: string) => void;
} {
  const [translated, setTranslated] = React.useState(block.translatedText);
  const [source, setSource] = React.useState(block.sourceText);
  const blockIdRef = React.useRef(block.id);

  React.useEffect(() => {
    const switched = blockIdRef.current !== block.id;
    blockIdRef.current = block.id;
    if (
      switched ||
      !translatedEditorRootRef.current?.contains(document.activeElement)
    ) {
      setTranslated(block.translatedText);
    }
    if (switched || document.activeElement !== sourceRef.current) {
      setSource(block.sourceText);
    }
  }, [
    block.id,
    block.translatedText,
    block.sourceText,
    translatedEditorRootRef,
    sourceRef,
  ]);

  const changeTranslated = (value: string): void => {
    setTranslated(value);
    React.startTransition(() => onUpdate({ translatedText: value }));
  };
  const changeSource = (value: string): void => {
    setSource(value);
    React.startTransition(() => onUpdate({ sourceText: value }));
  };
  return {
    translated,
    source,
    changeTranslated,
    changeSource,
  };
}
