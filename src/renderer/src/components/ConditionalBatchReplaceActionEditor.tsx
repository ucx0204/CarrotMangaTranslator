import { useTranslation } from "react-i18next";
import { appI18n } from "../appI18n";
import {
  type ConditionalBatchActionV2,
  type ConditionalBatchReplaceTextActionV2,
} from "../../../shared/conditionalBatchRules";

import { Select } from "./ui/Select";

import { Field } from "./ui/Field";

import { ConditionalPatternBuilder } from "./ConditionalPatternBuilder";

import styles from "./ConditionalBatchEditor.module.css";

const t = appI18n.getFixedT(null, "components");

export function ReplaceActionEditor({
  action,
  sampleText,
  onChange,
}: {
  action: ConditionalBatchReplaceTextActionV2;
  sampleText?: string;
  onChange: (action: ConditionalBatchActionV2) => void;
}) {
  useTranslation();
  const switchMode = (
    matcher: typeof action.matcher,
    replacement?: typeof action.replacement,
  ) =>
    onChange({
      ...action,
      matcher,
      replacement: replacement ?? action.replacement,
    });
  return (
    <>
      <div className={styles.actionOptions}>
        <Field as="div" label={t("batchEditorCopy.target")}>
          <Select
            ariaLabel={t("conditionalBatch.then.target")}
            value={action.target}
            options={replacementTargetOptions()}
            onValueChange={(target) =>
              onChange({
                ...action,
                target: target as ConditionalBatchReplaceTextActionV2["target"],
              })
            }
          />
        </Field>
        <Field as="div" label={t("batchEditorCopy.replacementScope")}>
          <Select
            ariaLabel={t("batchEditorCopy.replacementScope")}
            value={action.allOccurrences ? "all" : "first"}
            options={[
              {
                value: "all",
                label: t("batchEditorCopy.allMatches"),
              },
              {
                value: "first",
                label: t("batchEditorCopy.firstMatchOnly"),
              },
            ]}
            onValueChange={(value) =>
              onChange({ ...action, allOccurrences: value === "all" })
            }
          />
        </Field>
      </div>
      <ConditionalPatternBuilder
        matcher={action.matcher}
        replacement={action.replacement}
        sampleText={sampleText}
        onChangeMatcher={(matcher) => onChange({ ...action, matcher })}
        onChangeReplacement={(replacement) =>
          onChange({ ...action, replacement })
        }
        onSwitchToRaw={switchMode}
        onSwitchToVisual={switchMode}
      />
    </>
  );
}

function replacementTargetOptions() {
  return [
    {
      value: "translatedText",
      label: t("conditionalBatch.when.translatedText"),
    },
    {
      value: "sourceText",
      label: t("conditionalBatch.when.sourceText"),
    },
    {
      value: "both",
      label: t("conditionalBatch.then.targets.both"),
    },
  ];
}
