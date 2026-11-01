import { useTranslation } from "react-i18next";
import { IconBraces } from "@tabler/icons-react";

import {
  compileConditionalTextMatcher,
  tryConvertConditionalRegexToVisual,
  type ConditionalReplacementV3,
  type ConditionalTextMatcherV3,
} from "../../../shared/conditionalTextPattern";

import { Button } from "./ui/Button";
import { CheckboxField } from "./ui/CheckboxField";

import styles from "./ConditionalBatchEditor.module.css";

import { Input } from "./ui/Field";

import type { PatternBuilderProps } from "./conditionalPatternEditorModel";

export function AdvancedPatternCode({
  matcher,
  replacement,
  onChangeMatcher,
  onChangeReplacement,
  onSwitchToRaw,
}: PatternBuilderProps) {
  const { t } = useTranslation("components");
  let compiled;
  try {
    compiled = compileConditionalTextMatcher(matcher);
  } catch (error) {
    void error;
    compiled = null;
  }
  return (
    <details className={styles.patternAdvanced}>
      <summary>
        <IconBraces size={14} /> {t("patternEditorCopy.viewRegexCode")}
      </summary>
      <div>
        <code>
          {compiled
            ? `/${compiled.source}/${compiled.flags}`
            : t("patternEditorCopy.patternError")}
        </code>
        {compiled ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const rawMatcher: ConditionalTextMatcherV3 = {
                mode: "regex",
                source: compiled.source,
                caseSensitive: matcher.caseSensitive,
              };
              const rawReplacement =
                replacement?.mode === "visual"
                  ? ({
                      mode: "raw",
                      source: replacement.parts
                        .map((part) => {
                          if (part.kind === "literal") {
                            return part.text.replaceAll("$", () => "$$");
                          }
                          const name = compiled.captureNames.get(
                            part.captureId,
                          );
                          return name ? `$<${name}>` : "";
                        })
                        .join(""),
                    } satisfies ConditionalReplacementV3)
                  : replacement;
              if (onSwitchToRaw) {
                onSwitchToRaw(rawMatcher, rawReplacement);
              } else {
                onChangeMatcher(rawMatcher);
                if (rawReplacement && onChangeReplacement) {
                  onChangeReplacement(rawReplacement);
                }
              }
            }}
          >
            {t("patternEditorCopy.editCode")}
          </Button>
        ) : null}
      </div>
    </details>
  );
}

export function RawPatternEditor({
  matcher,
  replacement,
  onChangeMatcher,
  onChangeReplacement,
  onSwitchToVisual,
}: PatternBuilderProps & {
  matcher: Extract<ConditionalTextMatcherV3, { mode: "regex" }>;
}) {
  const { t } = useTranslation("components");
  const visual = tryConvertConditionalRegexToVisual(matcher, replacement);
  let error: string | null = null;
  try {
    compileConditionalTextMatcher(matcher);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return (
    <details className={styles.rawPatternEditor} open>
      <summary>{t("batchEditorCopy.advancedPattern")}</summary>
      <label className={styles.rawPatternField}>
        <span>{t("conditionalBatch.then.searchModes.regex")}</span>
        <Input
          aria-label={t("patternEditorCopy.regexCode")}
          value={matcher.source}
          aria-invalid={Boolean(error)}
          onChange={(event) =>
            onChangeMatcher({ ...matcher, source: event.target.value })
          }
        />
      </label>
      {replacement && onChangeReplacement ? (
        <label className={styles.rawPatternField}>
          <span>{t("patternEditorCopy.replace")}</span>
          <Input
            value={
              replacement.mode === "raw"
                ? replacement.source
                : replacement.parts
                    .map((part) => (part.kind === "literal" ? part.text : ""))
                    .join("")
            }
            onChange={(event) =>
              onChangeReplacement({ mode: "raw", source: event.target.value })
            }
          />
        </label>
      ) : null}
      <RawPatternOptions
        matcher={matcher}
        onChangeMatcher={onChangeMatcher}
        onChangeReplacement={onChangeReplacement}
        onSwitchToVisual={onSwitchToVisual}
        visual={visual}
      />
      {error ? <div className={styles.patternError}>{error}</div> : null}
    </details>
  );
}

function RawPatternOptions({
  matcher,
  onChangeMatcher,
  onChangeReplacement,
  onSwitchToVisual,
  visual,
}: {
  matcher: Extract<ConditionalTextMatcherV3, { mode: "regex" }>;
  onChangeMatcher: PatternBuilderProps["onChangeMatcher"];
  onChangeReplacement: PatternBuilderProps["onChangeReplacement"];
  onSwitchToVisual: PatternBuilderProps["onSwitchToVisual"];
  visual: ReturnType<typeof tryConvertConditionalRegexToVisual>;
}) {
  const { t } = useTranslation("components");
  return (
    <div className={styles.patternOptions}>
      <CheckboxField
        checked={matcher.caseSensitive}
        label={t("conditionalBatch.then.caseSensitive")}
        onCheckedChange={(caseSensitive) =>
          onChangeMatcher({ ...matcher, caseSensitive })
        }
      />
      <CheckboxField
        checked={Boolean(matcher.multiline)}
        label={t("patternEditorCopy.multiline")}
        onCheckedChange={(multiline) =>
          onChangeMatcher({ ...matcher, multiline: multiline || undefined })
        }
      />
      <CheckboxField
        checked={Boolean(matcher.dotAll)}
        label={t("patternEditorCopy.includeLineBreaks")}
        onCheckedChange={(dotAll) =>
          onChangeMatcher({ ...matcher, dotAll: dotAll || undefined })
        }
      />
      {visual ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (onSwitchToVisual) {
              onSwitchToVisual(visual.matcher, visual.replacement);
              return;
            }
            onChangeMatcher(visual.matcher);
            if (visual.replacement && onChangeReplacement) {
              onChangeReplacement(visual.replacement);
            }
          }}
        >
          {t("patternEditorCopy.returnToVisualBuilder")}
        </Button>
      ) : null}
    </div>
  );
}
