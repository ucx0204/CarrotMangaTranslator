import { useTranslation } from "react-i18next";
import { createConditionalLiteralMatcher } from "../../../shared/conditionalTextPattern";

import {
  type ConditionalBatchActionV2,
  type ConditionalBatchStyleTextActionV2,
} from "../../../shared/conditionalBatchRules";

import { type TextStylePatch } from "../../../shared/richTextMarkup";

import { CheckboxField } from "./ui/CheckboxField";
import { Select } from "./ui/Select";

import { Field } from "./ui/Field";

import { ConditionalPatternBuilder } from "./ConditionalPatternBuilder";

import styles from "./ConditionalBatchEditor.module.css";

import { updatePatch } from "./conditionalBatchActionModel";

import { ExistingStyleMatchEditor } from "./ConditionalBatchStyleMatchEditor";

import {
  PatchBoolean,
  PatchColorValue,
  PatchFontValue,
  PatchValue,
} from "./ConditionalBatchStylePatchFields";

export function StyleTextActionEditor({
  action,
  sampleText,
  onChange,
}: {
  action: ConditionalBatchStyleTextActionV2;
  sampleText?: string;
  onChange: (action: ConditionalBatchActionV2) => void;
}) {
  const { t } = useTranslation("components");
  const updateStyle = <Key extends keyof TextStylePatch>(
    key: Key,
    value: TextStylePatch[Key] | undefined,
  ): void => {
    onChange({
      ...action,
      patch: updatePatch(action.patch, key, value),
    });
  };
  return (
    <>
      <StyleTextScopeControls action={action} onChange={onChange} />
      {action.scope === "pattern" && action.matcher ? (
        <ConditionalPatternBuilder
          matcher={action.matcher}
          sampleText={sampleText}
          onChangeMatcher={(matcher) => onChange({ ...action, matcher })}
        />
      ) : null}
      <ExistingStyleMatchEditor action={action} onChange={onChange} />
      <h4>{t("batchEditorCopy.fontAndAppearance")}</h4>
      <StyleTextFontControls action={action} updateStyle={updateStyle} />
      <StyleTextEffectControls action={action} updateStyle={updateStyle} />
      {action.scope === "pattern" ? (
        <div className={styles.actionToggles}>
          <CheckboxField
            checked={action.allOccurrences}
            label={t("batchEditorCopy.allMatches")}
            onCheckedChange={(allOccurrences) =>
              onChange({ ...action, allOccurrences })
            }
          />
        </div>
      ) : null}
    </>
  );
}

function StyleTextScopeControls({
  action,
  onChange,
}: {
  action: ConditionalBatchStyleTextActionV2;
  onChange: (action: ConditionalBatchActionV2) => void;
}) {
  const { t } = useTranslation("components");
  return (
    <div className={styles.actionOptions}>
      <Field as="div" label={t("batchEditorCopy.formattingScope")}>
        <Select
          ariaLabel={t("batchEditorCopy.formattingScope")}
          value={action.scope}
          options={[
            {
              value: "allText",
              label: t("batchEditorCopy.wholeText"),
            },
            {
              value: "pattern",
              label: t("batchEditorCopy.matchedTextOnly"),
            },
          ]}
          onValueChange={(scope) =>
            onChange({
              ...action,
              scope: scope as ConditionalBatchStyleTextActionV2["scope"],
              matcher:
                scope === "pattern"
                  ? (action.matcher ?? createConditionalLiteralMatcher(""))
                  : undefined,
            })
          }
        />
      </Field>
      <Field as="div" label={t("batchEditorCopy.existingInlineFormatting")}>
        <Select
          ariaLabel={t("batchEditorCopy.inlineFormattingMode")}
          value={action.styleMode}
          options={[
            {
              value: "overwrite",
              label: t("batchEditorCopy.overwriteSpecifiedProperties"),
            },
            {
              value: "fillMissing",
              label: t("batchEditorCopy.fillEmptyValuesOnly"),
            },
            {
              value: "replace",
              label: t("batchEditorCopy.clearAndReplaceFormatting"),
            },
          ]}
          onValueChange={(styleMode) =>
            onChange({
              ...action,
              styleMode:
                styleMode as ConditionalBatchStyleTextActionV2["styleMode"],
            })
          }
        />
      </Field>
    </div>
  );
}

function StyleTextFontControls({
  action,
  updateStyle,
}: {
  action: ConditionalBatchStyleTextActionV2;
  updateStyle: <Key extends keyof TextStylePatch>(
    key: Key,
    value: TextStylePatch[Key] | undefined,
  ) => void;
}) {
  const { t } = useTranslation("components");
  return (
    <div className={styles.inlineStyleGrid}>
      <PatchBoolean
        label={t("format.bold")}
        value={action.patch.bold}
        onChange={(bold) => updateStyle("bold", bold)}
      />
      <PatchBoolean
        label={t("format.italicShort")}
        value={action.patch.italic}
        onChange={(italic) => updateStyle("italic", italic)}
      />
      <PatchBoolean
        label={t("format.characterFormat.underline")}
        value={action.patch.underline}
        onChange={(underline) => updateStyle("underline", underline)}
      />
      <PatchBoolean
        label={t("format.characterFormat.strikethrough")}
        value={action.patch.strikethrough}
        onChange={(strikethrough) =>
          updateStyle("strikethrough", strikethrough)
        }
      />
      <PatchBoolean
        label={t("format.characterFormat.emphasisMark")}
        value={action.patch.emphasisMark}
        onChange={(emphasisMark) => updateStyle("emphasisMark", emphasisMark)}
      />
      <PatchValue
        label={t("format.fontSize")}
        field="fontSizePx"
        value={action.patch.sizePx}
        onChange={(sizePx) => updateStyle("sizePx", sizePx)}
      />
      <PatchFontValue
        value={action.patch.fontFamily}
        onChange={(fontFamily) => updateStyle("fontFamily", fontFamily)}
      />
      <PatchValue
        label={t("batchEditorCopy.textOpacity")}
        field="textOpacity"
        value={action.patch.opacity}
        onChange={(opacity) => updateStyle("opacity", opacity)}
      />
      <PatchValue
        label={t("format.fontWidth")}
        field="fontWidthScale"
        value={action.patch.widthScale}
        onChange={(widthScale) => updateStyle("widthScale", widthScale)}
      />
    </div>
  );
}

function StyleTextEffectControls({
  action,
  updateStyle,
}: {
  action: ConditionalBatchStyleTextActionV2;
  updateStyle: <Key extends keyof TextStylePatch>(
    key: Key,
    value: TextStylePatch[Key] | undefined,
  ) => void;
}) {
  const { t } = useTranslation("components");
  return (
    <div className={styles.inlineStyleAdvanced}>
      <h4>{t("batchEditorCopy.colorsAndEffects")}</h4>
      <div className={styles.inlineStyleGrid}>
        <PatchColorValue
          label={t("format.textColor")}
          value={action.patch.color}
          onChange={(color) => updateStyle("color", color)}
        />
        <PatchColorValue
          label={t("batchEditorCopy.textBackgroundColor")}
          value={action.patch.backgroundColor}
          onChange={(backgroundColor) =>
            updateStyle("backgroundColor", backgroundColor)
          }
        />
        <PatchColorValue
          label={t("batchEditorCopy.outlineColor")}
          value={action.patch.outlineColor}
          onChange={(outlineColor) => updateStyle("outlineColor", outlineColor)}
        />
        <PatchValue
          label={t("settings.format.color.outlineWidth")}
          field="outlineWidthPx"
          value={action.patch.outlineWidthPx}
          onChange={(outlineWidthPx) =>
            updateStyle("outlineWidthPx", outlineWidthPx)
          }
        />
        <PatchColorValue
          label={t("batchEditorCopy.outerOutlineColor")}
          value={action.patch.outerOutlineColor}
          onChange={(outerOutlineColor) =>
            updateStyle("outerOutlineColor", outerOutlineColor)
          }
        />
        <PatchValue
          label={t("format.outerOutline.width")}
          field="outerOutlineWidthPx"
          value={action.patch.outerOutlineWidthPx}
          onChange={(outerOutlineWidthPx) =>
            updateStyle("outerOutlineWidthPx", outerOutlineWidthPx)
          }
        />
        <PatchColorValue
          label={t("batchEditorCopy.glowColor")}
          value={action.patch.glowColor}
          onChange={(glowColor) => updateStyle("glowColor", glowColor)}
        />
        <PatchValue
          label={t("batchEditorCopy.glowSpread")}
          field="textGlowBlur"
          value={action.patch.glowBlurPx}
          onChange={(glowBlurPx) => updateStyle("glowBlurPx", glowBlurPx)}
        />
        <PatchValue
          label={t("batchEditorCopy.glowOpacity")}
          field="textGlowOpacity"
          value={action.patch.glowOpacity}
          onChange={(glowOpacity) => updateStyle("glowOpacity", glowOpacity)}
        />
      </div>
    </div>
  );
}
