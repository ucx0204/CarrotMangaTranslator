import React from "react";
import { useTranslation } from "react-i18next";
import { RichTranslationInlineStylePanel } from "./RichTranslationInlineStylePanel";
import type {
  RichTranslationEditorMode,
  RichTranslationInlineStyleAction,
  RichTranslationSelectionValues,
} from "./richTranslationEditorTypes";
import type { RichTranslationVisualEditor } from "./useRichTranslationVisualEditor";
import { Button } from "./ui/Button";
import { Textarea } from "./ui/Field";
import { IconButton } from "./ui/IconButton";
import { CodeIcon, RestoreIcon, TypeStyleIcon } from "./ui/icons";

const SPECIAL_CHARACTERS = [
  "…",
  "—",
  "〜",
  "!!",
  "!?",
  "?!",
  "??",
  "♡",
  "♥",
  "♪",
  "♬",
] as const;

type RichTranslationEditorViewProps = {
  afterEditor?: React.ReactNode;
  applyInlineStyle: RichTranslationInlineStyleAction;
  clearAllFormatting: () => void;
  codeRef: React.RefObject<HTMLTextAreaElement | null>;
  disabled: boolean;
  editorRootRef: React.RefObject<HTMLDivElement | null>;
  heightRefCallback: (element: HTMLElement | null) => void;
  insertSpecialCharacter: (character: string) => void;
  mode: RichTranslationEditorMode;
  onChange: (value: string) => void;
  onCodeSelect: React.ReactEventHandler<HTMLTextAreaElement>;
  plainText: string;
  selectionValues: RichTranslationSelectionValues;
  setMode: (mode: RichTranslationEditorMode) => void;
  specialCharactersId: string;
  specialCharactersOpen: boolean;
  toggleSpecialCharacters: () => void;
  value: string;
  visual: RichTranslationVisualEditor;
};

export function RichTranslationEditorView({
  afterEditor,
  applyInlineStyle,
  clearAllFormatting,
  codeRef,
  disabled,
  editorRootRef,
  heightRefCallback,
  insertSpecialCharacter,
  mode,
  onChange,
  onCodeSelect,
  plainText,
  selectionValues,
  setMode,
  specialCharactersId,
  specialCharactersOpen,
  toggleSpecialCharacters,
  value,
  visual,
}: RichTranslationEditorViewProps): React.JSX.Element {
  return (
    <div
      className="rich-translation-editor"
      ref={editorRootRef}
      onPointerDownCapture={visual.captureSelectionBeforeControlFocus}
    >
      <RichTranslationEditorHeader
        clearAllFormatting={clearAllFormatting}
        disabled={disabled}
        mode={mode}
        plainText={plainText}
        setMode={setMode}
        specialCharactersId={specialCharactersId}
        specialCharactersOpen={specialCharactersOpen}
        toggleSpecialCharacters={toggleSpecialCharacters}
        value={value}
      />
      <SpecialCharacterPalette
        disabled={disabled}
        id={specialCharactersId}
        open={specialCharactersOpen}
        onInsert={insertSpecialCharacter}
      />
      <RichTranslationEditorInput
        codeRef={codeRef}
        disabled={disabled}
        heightRefCallback={heightRefCallback}
        mode={mode}
        onChange={onChange}
        onCodeSelect={onCodeSelect}
        plainText={plainText}
        value={value}
        visual={visual}
      />
      {afterEditor}
      <RichTranslationInlineStylePanel
        disabled={disabled}
        mode={mode}
        values={selectionValues}
        onApplyStyle={applyInlineStyle}
      />
    </div>
  );
}

type EditorHeaderProps = Pick<
  RichTranslationEditorViewProps,
  | "clearAllFormatting"
  | "disabled"
  | "mode"
  | "plainText"
  | "setMode"
  | "specialCharactersId"
  | "specialCharactersOpen"
  | "toggleSpecialCharacters"
  | "value"
>;

function RichTranslationEditorHeader(
  props: EditorHeaderProps,
): React.JSX.Element {
  return (
    <div className="rich-editor-header">
      <RichTranslationModePicker mode={props.mode} setMode={props.setMode} />
      <RichTranslationEditorToolbar {...props} />
    </div>
  );
}

function RichTranslationModePicker({
  mode,
  setMode,
}: Pick<EditorHeaderProps, "mode" | "setMode">): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="rich-editor-heading">
      <h3>{t("editor.translatedText")}</h3>
      <div
        className="rich-editor-mode-toggle"
        aria-label={t("editor.richText.modeLabel", {
          defaultValue: "번역문 보기 방식",
        })}
      >
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={mode === "visual"}
          iconLeft={<TypeStyleIcon size={13} />}
          onClick={() => setMode("visual")}
        >
          {t("editor.richText.visualMode", { defaultValue: "편집" })}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={mode === "code"}
          iconLeft={<CodeIcon size={13} />}
          onClick={() => setMode("code")}
        >
          {t("editor.richText.codeMode", { defaultValue: "코드" })}
        </Button>
      </div>
    </div>
  );
}

function RichTranslationEditorToolbar({
  clearAllFormatting,
  disabled,
  plainText,
  specialCharactersId,
  specialCharactersOpen,
  toggleSpecialCharacters,
  value,
}: EditorHeaderProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="rich-editor-toolbar">
      <Button
        size="sm"
        variant="ghost"
        className="rich-special-character-trigger"
        aria-controls={specialCharactersId}
        aria-expanded={specialCharactersOpen}
        disabled={disabled}
        iconLeft={<span aria-hidden="true">Ω</span>}
        onClick={toggleSpecialCharacters}
      >
        {t("editor.richText.specialCharacters", { defaultValue: "기호" })}
      </Button>
      <IconButton
        size="sm"
        label={t("editor.richText.resetAll", {
          defaultValue: "번역문 서식 전체 초기화",
        })}
        title={t("editor.richText.resetAllTitle", {
          defaultValue: "번역문 안의 모든 강조와 글자별 서식 제거",
        })}
        disabled={disabled || plainText === value}
        onClick={clearAllFormatting}
      >
        <RestoreIcon size={14} />
      </IconButton>
    </div>
  );
}

function SpecialCharacterPalette({
  disabled,
  id,
  onInsert,
  open,
}: {
  disabled: boolean;
  id: string;
  onInsert: (character: string) => void;
  open: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (!open) return null;
  return (
    <div
      id={id}
      className="rich-special-character-panel"
      role="group"
      aria-label={t("editor.richText.specialCharacters", {
        defaultValue: "특수문자",
      })}
    >
      {SPECIAL_CHARACTERS.map((character) => (
        <Button
          key={character}
          size="sm"
          variant="ghost"
          title={t("editor.richText.insertSpecialCharacter", {
            character,
            defaultValue: "{{character}} 입력",
          })}
          disabled={disabled}
          onClick={() => onInsert(character)}
        >
          {character}
        </Button>
      ))}
    </div>
  );
}

type EditorInputProps = Pick<
  RichTranslationEditorViewProps,
  | "codeRef"
  | "disabled"
  | "heightRefCallback"
  | "mode"
  | "onChange"
  | "onCodeSelect"
  | "plainText"
  | "value"
  | "visual"
>;

function RichTranslationEditorInput(
  props: EditorInputProps,
): React.JSX.Element {
  return props.mode === "visual" ? (
    <VisualTranslationInput
      disabled={props.disabled}
      heightRefCallback={props.heightRefCallback}
      plainText={props.plainText}
      visual={props.visual}
    />
  ) : (
    <CodeTranslationInput
      codeRef={props.codeRef}
      disabled={props.disabled}
      heightRefCallback={props.heightRefCallback}
      onChange={props.onChange}
      onSelect={props.onCodeSelect}
      value={props.value}
    />
  );
}

function VisualTranslationInput({
  disabled,
  heightRefCallback,
  plainText,
  visual,
}: Pick<
  EditorInputProps,
  "disabled" | "heightRefCallback" | "plainText" | "visual"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div
      ref={(element) => {
        visual.visualRef.current = element;
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
      data-empty={plainText.length === 0 ? "true" : undefined}
      data-placeholder={t("editor.richText.placeholder", {
        defaultValue: "번역문을 입력하세요",
      })}
      onInput={() => visual.commitInput()}
      onBeforeInput={visual.onBeforeInput}
      onCompositionStart={visual.onCompositionStart}
      onCompositionEnd={visual.onCompositionEnd}
      onKeyUp={visual.updateSelection}
      onPointerUp={visual.updateSelection}
      onPaste={visual.onPaste}
    />
  );
}

function CodeTranslationInput({
  codeRef,
  disabled,
  heightRefCallback,
  onChange,
  onSelect,
  value,
}: {
  codeRef: React.RefObject<HTMLTextAreaElement | null>;
  disabled: boolean;
  heightRefCallback: (element: HTMLElement | null) => void;
  onChange: (value: string) => void;
  onSelect: React.ReactEventHandler<HTMLTextAreaElement>;
  value: string;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <Textarea
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
      onSelect={onSelect}
    />
  );
}
