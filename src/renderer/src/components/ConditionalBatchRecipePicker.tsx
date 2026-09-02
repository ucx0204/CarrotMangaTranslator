import React from "react";
import type { ConditionalBatchRulePanelProps } from "./conditionalBatchRulePanelTypes";
import { Button } from "./ConditionalBatchControls";
import styles from "./ConditionalBatchEditor.module.css";

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
  const favoriteIds = new Set(props.favoriteSchemeIds);
  const quickSchemes = props.savedSchemes.filter((scheme) =>
    favoriteIds.has(scheme.id),
  );
  return (
    <section className={styles.recipePanel}>
      <header>
        <strong>새 규칙</strong>
        <div className={styles.recipeHeaderActions}>
          {props.recipePickerCanClose ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={props.onCloseRecipePicker}
            >
              닫기
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
          직접 규칙 생성
        </Button>
      </div>
    </section>
  );
}
