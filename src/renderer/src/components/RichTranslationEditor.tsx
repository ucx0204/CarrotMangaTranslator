import React from "react";
import type { TranslationBlock } from "../../../shared/textTypes";
import { RichTranslationEditorView } from "./RichTranslationEditorView";
import { useRichTranslationEditorController } from "./useRichTranslationEditorController";

type RichTranslationEditorProps = {
  afterEditor?: React.ReactNode;
  block: TranslationBlock;
  disabled: boolean;
  editorRootRef: React.RefObject<HTMLDivElement | null>;
  heightRefCallback: (element: HTMLElement | null) => void;
  onChange: (value: string) => void;
  value: string;
};

export function RichTranslationEditor(
  props: RichTranslationEditorProps,
): React.JSX.Element {
  const controller = useRichTranslationEditorController({
    block: props.block,
    editorRootRef: props.editorRootRef,
    onChange: props.onChange,
    value: props.value,
  });
  return (
    <RichTranslationEditorView
      afterEditor={props.afterEditor}
      applyInlineStyle={controller.applyInlineStyle}
      clearAllFormatting={controller.clearAllFormatting}
      codeRef={controller.code.codeRef}
      disabled={props.disabled}
      editorRootRef={props.editorRootRef}
      heightRefCallback={props.heightRefCallback}
      insertSpecialCharacter={controller.insertSpecialCharacter}
      mode={controller.mode}
      onChange={props.onChange}
      onCodeSelect={controller.code.onSelect}
      plainText={controller.plainText}
      selectionValues={controller.selectionValues}
      setMode={controller.setMode}
      specialCharactersId={controller.specialCharacters.id}
      specialCharactersOpen={controller.specialCharacters.open}
      toggleSpecialCharacters={controller.specialCharacters.toggle}
      value={props.value}
      visual={controller.visual}
    />
  );
}
