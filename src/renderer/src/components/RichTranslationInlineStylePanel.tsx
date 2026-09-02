import React from "react";
import { useTranslation } from "react-i18next";
import { RichTranslationInlineAppearance } from "./RichTranslationInlineAppearance";
import { RichTranslationInlineTypography } from "./RichTranslationInlineTypography";
import type {
  RichTranslationEditorMode,
  RichTranslationInlineStyleAction,
  RichTranslationSelectionValues,
} from "./richTranslationEditorTypes";

type RichTranslationInlineStylePanelProps = {
  disabled: boolean;
  mode: RichTranslationEditorMode;
  values: RichTranslationSelectionValues;
  onApplyStyle: RichTranslationInlineStyleAction;
};

export function RichTranslationInlineStylePanel(
  props: RichTranslationInlineStylePanelProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section
      className="rich-inline-style-panel"
      aria-label={t("editor.richText.inlineStyle", {
        defaultValue: "글자별 서식",
      })}
    >
      <RichTranslationInlineTypography {...props} />
      <RichTranslationInlineAppearance
        disabled={props.disabled}
        values={props.values}
        onApplyStyle={props.onApplyStyle}
      />
    </section>
  );
}
