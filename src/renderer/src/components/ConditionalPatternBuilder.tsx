import { useTranslation } from "react-i18next";
import React from "react";

import {
  collectCaptureIds,
  createConditionalLiteralMatcher,
} from "../../../shared/conditionalTextPattern";

import { Button } from "./ui/Button";
import { CheckboxField } from "./ui/CheckboxField";

import styles from "./ConditionalBatchEditor.module.css";

import {
  AdvancedPatternCode,
  RawPatternEditor,
} from "./ConditionalPatternCodeEditor";

import { PatternLane } from "./ConditionalPatternLane";

import { ReplacementLane } from "./ConditionalReplacementLane";
import type { PatternBuilderProps } from "./conditionalPatternEditorModel";

export function ConditionalPatternBuilder({
  matcher,
  replacement,
  sampleText,
  onChangeMatcher,
  onChangeReplacement,
  onSwitchToRaw,
  onSwitchToVisual,
}: PatternBuilderProps): React.JSX.Element {
  const { t } = useTranslation("components");
  if (matcher.mode === "regex") {
    return (
      <RawPatternEditor
        matcher={matcher}
        replacement={replacement}
        onChangeMatcher={onChangeMatcher}
        onChangeReplacement={onChangeReplacement}
        onSwitchToRaw={onSwitchToRaw}
        onSwitchToVisual={onSwitchToVisual}
      />
    );
  }

  const captureIds = [...collectCaptureIds(matcher)];
  const captureLabels = new Map(
    captureIds.map((captureId, index) => [
      captureId,
      t("patternEditorCopy.captureNumber", { count: index + 1 }),
    ]),
  );
  return (
    <div className={styles.patternBuilder}>
      <PatternLane
        label={t("patternEditorCopy.find")}
        nodes={matcher.nodes}
        captureLabels={captureLabels}
        onChange={(nodes) => onChangeMatcher({ ...matcher, nodes })}
      />
      {replacement && onChangeReplacement ? (
        <ReplacementLane
          replacement={replacement}
          captureIds={captureIds}
          captureLabels={captureLabels}
          onChange={onChangeReplacement}
        />
      ) : null}
      <div className={styles.patternOptions}>
        <CheckboxField
          checked={matcher.caseSensitive}
          label={t("conditionalBatch.then.caseSensitive")}
          onCheckedChange={(caseSensitive) =>
            onChangeMatcher({ ...matcher, caseSensitive })
          }
        />
        {sampleText ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              onChangeMatcher(
                createConditionalLiteralMatcher(
                  sampleText,
                  matcher.caseSensitive,
                ),
              )
            }
          >
            {t("patternEditorCopy.useTextFromTheCurrentBalloon")}
          </Button>
        ) : null}
      </div>
      <AdvancedPatternCode
        matcher={matcher}
        replacement={replacement}
        onChangeMatcher={onChangeMatcher}
        onChangeReplacement={onChangeReplacement}
        onSwitchToRaw={onSwitchToRaw}
      />
    </div>
  );
}
