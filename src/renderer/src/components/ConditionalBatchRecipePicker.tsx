import { useTranslation } from "react-i18next";
import React from "react";
import styles from "./ConditionalBatchEditor.module.css";
import type { ConditionalBatchRulePanelProps } from "./conditionalBatchRulePanelTypes";
import { Button } from "./ui/Button";

type ConditionalBatchRecipePickerProps = Pick<
  ConditionalBatchRulePanelProps,
  | "favoriteSchemeIds"
  | "onChooseRecipe"
  | "onCloseRecipePicker"
  | "onSelectScheme"
  | "recipePickerCanClose"
  | "savedSchemes"
>;

export function ConditionalBatchRecipePicker(
  props: ConditionalBatchRecipePickerProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const favoriteIds = new Set(props.favoriteSchemeIds);
  const quickSchemes = props.savedSchemes.filter((scheme) =>
    favoriteIds.has(scheme.id),
  );
  return (
    <section className={styles.recipePanel}>
      <header>
        <strong>{t("conditionalBatch.scheme.new")}</strong>
        <div className={styles.recipeHeaderActions}>
          {props.recipePickerCanClose ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={props.onCloseRecipePicker}
            >
              {t("common.close")}
            </Button>
          ) : null}
        </div>
      </header>
      <div className={styles.recipeGrid}>
        {quickSchemes.map((scheme) => (
          <Button
            key={scheme.id}
            size="sm"
            fullWidth
            onClick={() => {
              props.onCloseRecipePicker();
              props.onSelectScheme(scheme.id);
            }}
          >
            {scheme.name}
          </Button>
        ))}
        <Button
          className={styles.directRecipe}
          fullWidth
          variant="primary"
          onClick={() => props.onChooseRecipe("blank")}
        >
          {t("batchEditorCopy.createARule")}
        </Button>
      </div>
    </section>
  );
}
