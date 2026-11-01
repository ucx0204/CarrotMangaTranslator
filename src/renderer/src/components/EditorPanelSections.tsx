import React from "react";
import { useTranslation } from "react-i18next";
import type { PanelTextSelection } from "../../../shared/panelBridgeTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import { useStickyTextareaHeight } from "../hooks/useStickyTextareaHeight";
import {
  deriveSingleTextReplacement,
  type ConsistentEditSuggestion,
} from "../lib/consistentEditSuggestion";
import { EditorDisclosure } from "./EditorDisclosure";
import type { CharacterFormatTarget } from "./editorCharacterFormatTarget";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { RestoreIcon, TextareaHeightIcon } from "./ui/icons";
import { RichTranslationEditor } from "./RichTranslationEditor";
import styles from "./EditorPanelSections.module.css";
import { Textarea } from "./ui/Field";

type BlockPatchHandler = (patch: Partial<TranslationBlock>) => void;

type BlockSectionProps = {
  block: TranslationBlock;
  disabled: boolean;
  onUpdate: BlockPatchHandler;
};

type BlockTextEditorProps = {
  onPreviewTextSelection?: (selection: PanelTextSelection) => void;
  pageSize?: { width: number; height: number } | null;
  renderCharacterFormat?: (target: CharacterFormatTarget) => React.ReactNode;
  resolvedFontSizePx?: number | null;
  selectionKey?: string;
  textEditRequestToken?: number;
  textResetToken?: number;
  onSuggestConsistentEdit?: (find: string, replace: string) => void;
  /** Image actions on the active block's original text and bubble. */
  sourceActions?: SourceActions;
};

type SourceActions = {
  aiUnavailable?: boolean;
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
  onSuggestConsistentEdit,
  onUpdate,
  sourceActions,
  ...editorProps
}: BlockSectionProps & BlockTextEditorProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const heights = useEditorTextareaHeights();
  const translatedEditorRootRef = React.useRef<HTMLDivElement | null>(null);
  const sourceRef = React.useRef<HTMLTextAreaElement | null>(null);
  const drafts = useBlockTextDrafts(block, onUpdate);
  const setSourceRef = React.useCallback(
    (element: HTMLTextAreaElement | null) => {
      sourceRef.current = element;
      heights.sourceRef(element);
    },
    [heights],
  );

  return (
    <div className="editor-group editor-text-group">
      <RichTranslationEditor
        {...editorProps}
        block={block}
        value={drafts.translated}
        disabled={disabled}
        editorRootRef={translatedEditorRootRef}
        heightRefCallback={heights.translatedRef}
        onChange={drafts.changeTranslated}
        afterInput={
          <>
            <GeneratedLetteringOption
              block={block}
              disabled={disabled}
              onUpdate={onUpdate}
            />
            <ConsistentEditSuggestionButton
              suggestion={drafts.suggestion}
              disabled={disabled}
              onApply={onSuggestConsistentEdit}
              onClear={drafts.clearSuggestion}
            />
          </>
        }
        afterEditor={
          <EditorDisclosure
            id="source"
            label={t("editor.sourceText")}
            headerExtra={
              <SourceActionButtons disabled={disabled} {...sourceActions} />
            }
            actions={<ResetTextareaHeightsButton onReset={heights.reset} />}
          >
            <Textarea
              ref={setSourceRef}
              className={styles.sourceText}
              aria-label={t("editor.sourceText")}
              rows={2}
              value={drafts.source}
              readOnly={disabled}
              onChange={(event) => {
                if (!disabled) drafts.changeSource(event.target.value);
              }}
            />
          </EditorDisclosure>
        }
      />
    </div>
  );
}

function SourceActionButtons({
  aiUnavailable,
  disabled,
  onEraseOriginal,
  onFitBubble,
}: SourceActions & { disabled: boolean }): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (!onEraseOriginal && !onFitBubble) return null;
  const actionDisabled = disabled || aiUnavailable === true;
  return (
    <div className={styles.sourceActions}>
      {onEraseOriginal ? (
        <Button
          size="sm"
          aria-label={t("editor.eraseOriginalScope")}
          title={t("editor.eraseOriginalScope")}
          disabled={actionDisabled}
          onClick={onEraseOriginal}
        >
          {t("editor.eraseOriginal")}
        </Button>
      ) : null}
      {onFitBubble ? (
        <Button
          size="sm"
          aria-label={t("editor.fitBubbleScope")}
          title={t("editor.fitBubbleScope")}
          disabled={actionDisabled}
          onClick={onFitBubble}
        >
          {t("editor.fitBubble")}
        </Button>
      ) : null}
    </div>
  );
}

/** Remembered heights of the translation and OCR inputs. */
function useEditorTextareaHeights(): {
  translatedRef: (element: HTMLElement | null) => void;
  sourceRef: (element: HTMLTextAreaElement | null) => void;
  reset: () => void;
} {
  const translated = useStickyTextareaHeight(
    "editor.textareaHeight.translated",
  );
  const source = useStickyTextareaHeight("editor.textareaHeight.source");
  const resetTranslated = translated.reset;
  const resetSource = source.reset;
  const reset = React.useCallback(() => {
    resetTranslated();
    resetSource();
  }, [resetTranslated, resetSource]);
  return React.useMemo(
    () => ({
      translatedRef: translated.refCallback,
      sourceRef: source.refCallback,
      reset,
    }),
    [translated.refCallback, source.refCallback, reset],
  );
}

function ResetTextareaHeightsButton({
  onReset,
}: {
  onReset: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <IconButton
      size="sm"
      label={t("editor.markupToolbar.resetHeight")}
      title={t("editor.markupToolbar.resetHeight")}
      onClick={onReset}
    >
      <TextareaHeightIcon size={14} />
    </IconButton>
  );
}

function GeneratedLetteringOption({
  block,
  disabled,
  onUpdate,
}: BlockSectionProps): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const artwork = block.generatedLettering;
  if (!artwork) return null;
  const matching =
    artwork.translatedText === block.translatedText &&
    artwork.sourceText === block.sourceText;
  const active = matching && artwork.enabled !== false;
  return (
    <div className={styles.letteringStatus}>
      <span className={styles.statusText} role="status">
        {t(
          active
            ? "codexTypesetting.imageActive"
            : "codexTypesetting.imageEdited",
        )}
      </span>
      <Button
        size="sm"
        variant="secondary"
        disabled={disabled || !matching}
        onClick={() =>
          onUpdate({ generatedLettering: { ...artwork, enabled: !active } })
        }
      >
        {t(
          active
            ? "codexTypesetting.editableText"
            : "codexTypesetting.restoreImage",
        )}
      </Button>
    </div>
  );
}

/**
 * Local, optimistic text state for the editor textareas so typing stays instant
 * and cursor-stable even when updates round-trip through the panel bridge (in a
 * popped-out window). Upstream values re-sync on block switch, or on external
 * edits including undo while focused. Queued acknowledgements never replace a newer local draft.
 */
function useBlockTextDrafts(
  block: TranslationBlock,
  onUpdate: BlockPatchHandler,
): {
  translated: string;
  source: string;
  changeTranslated: (value: string, patch?: Partial<TranslationBlock>) => void;
  changeSource: (value: string) => void;
  suggestion: ConsistentEditSuggestion | null;
  clearSuggestion: () => void;
} {
  const [translated, setTranslated] = React.useState(block.translatedText);
  const [source, setSource] = React.useState(block.sourceText);
  const [translatedBaseline, setTranslatedBaseline] = React.useState<
    string | null
  >(null);
  const blockIdRef = React.useRef(block.id);
  const pendingTranslated = React.useRef<string[]>([]);
  const pendingSource = React.useRef<string[]>([]);

  React.useEffect(() => {
    const switched = blockIdRef.current !== block.id;
    blockIdRef.current = block.id;
    const sync = (
      incoming: string,
      pending: string[],
      update: (value: string) => void,
    ): void => {
      if (switched) pending.length = 0;
      const acknowledged = pending.indexOf(incoming);
      if (acknowledged >= 0) {
        pending.splice(0, acknowledged + 1);
        if (pending.length) return;
      } else pending.length = 0;
      update(incoming);
    };
    sync(block.translatedText, pendingTranslated.current, setTranslated);
    sync(block.sourceText, pendingSource.current, setSource);
    if (switched) setTranslatedBaseline(null);
  }, [block.id, block.translatedText, block.sourceText]);

  const changeTranslated = (
    value: string,
    patch?: Partial<TranslationBlock>,
  ): void => {
    // A whole-block format change that leaves the markup untouched is sent as
    // the block patch alone, so it reads as formatting rather than a text edit.
    if (patch && value === translated) {
      React.startTransition(() => onUpdate(patch));
      return;
    }
    pendingTranslated.current.push(value);
    setTranslatedBaseline((current) => current ?? translated);
    setTranslated(value);
    React.startTransition(() => onUpdate({ ...patch, translatedText: value }));
  };
  const changeSource = (value: string): void => {
    pendingSource.current.push(value);
    setSource(value);
    React.startTransition(() => onUpdate({ sourceText: value }));
  };
  return {
    translated,
    source,
    changeTranslated,
    changeSource,
    suggestion:
      translatedBaseline === null
        ? null
        : deriveSingleTextReplacement(translatedBaseline, translated),
    clearSuggestion: () => setTranslatedBaseline(null),
  };
}

function ConsistentEditSuggestionButton({
  suggestion,
  disabled,
  onApply,
  onClear,
}: {
  suggestion: ConsistentEditSuggestion | null;
  disabled: boolean;
  onApply?: (find: string, replace: string) => void;
  onClear: () => void;
}) {
  if (!suggestion || !onApply) return null;
  return (
    <div className="editor-consistent-edit-suggestion">
      <span>
        “{suggestion.find}” → “{suggestion.replace}”
      </span>
      <Button
        size="sm"
        disabled={disabled}
        onClick={() => {
          onClear();
          onApply(suggestion.find, suggestion.replace);
        }}
      >
        비슷한 곳도 바꾸기
      </Button>
    </div>
  );
}
