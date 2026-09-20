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
  hasSelection: boolean;
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
      <div className="rich-inline-scope">
        <strong>{t("editor.richText.inlineStyle")}</strong>
        <span>
          {t(
            props.hasSelection
              ? "editor.richText.scopeSelection"
              : props.mode === "code"
                ? "editor.richText.scopeCodeCaret"
                : "editor.richText.scopeCaret",
          )}
        </span>
      </div>
      <RichTranslationInlineTypography {...props} />
      <RichTranslationInlineAppearance
        disabled={props.disabled}
        values={props.values}
        onApplyStyle={props.onApplyStyle}
      />
    </section>
  );
}
