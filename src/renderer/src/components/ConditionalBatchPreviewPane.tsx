import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import React from "react";
import { useTranslation } from "react-i18next";
import type { AppWorkspaceProps } from "./appWorkspaceTypes";
import { AppWorkspace } from "./AppWorkspace";
import { Button } from "./ConditionalBatchControls";
import { SegmentedControl } from "./ui/SegmentedControl";
import styles from "./ConditionalBatchEditor.module.css";

export type ConditionalBatchPreviewPaneProps = {
  currentResultIndex: number;
  pageName: string;
  previewMode: "before" | "after";
  resultCount: number;
  workspaceProps: AppWorkspaceProps;
  onChangePreviewMode: (mode: "before" | "after") => void;
  onMoveResult: (offset: number) => void;
};

export function ConditionalBatchPreviewPane(
  props: ConditionalBatchPreviewPaneProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const noResults = props.resultCount === 0;
  return (
    <section className={styles.previewRegion}>
      <header className={styles.previewHeader}>
        <div className={styles.previewTitle}>
          <strong>{props.pageName}</strong>
        </div>
        <div className={styles.previewControls}>
          <Button
            size="sm"
            aria-label={t("conditionalBatch.results.previous")}
            disabled={noResults}
            iconLeft={<IconChevronLeft size={16} />}
            onClick={() => props.onMoveResult(-1)}
          />
          <span className={styles.resultPosition} aria-live="polite">
            {noResults
              ? t("conditionalBatch.results.noneShort")
              : t("conditionalBatch.results.position", {
                  current: props.currentResultIndex + 1,
                  total: props.resultCount,
                })}
          </span>
          <Button
            size="sm"
            aria-label={t("conditionalBatch.results.next")}
            disabled={noResults}
            iconLeft={<IconChevronRight size={16} />}
            onClick={() => props.onMoveResult(1)}
          />
          <SegmentedControl
            ariaLabel={t("conditionalBatch.preview.modeLabel")}
            singleRow
            options={[
              { id: "before", label: t("conditionalBatch.preview.before") },
              { id: "after", label: t("conditionalBatch.preview.after") },
            ]}
            value={props.previewMode}
            onChange={props.onChangePreviewMode}
          />
        </div>
      </header>
      <div className={styles.previewCanvas}>
        <AppWorkspace {...props.workspaceProps} />
      </div>
    </section>
  );
}
