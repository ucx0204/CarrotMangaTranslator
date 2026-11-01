import { useTranslation } from "react-i18next";
import { IconArrowBackUp, IconWand } from "@tabler/icons-react";
import React from "react";
import styles from "./ConditionalBatchEditor.module.css";
import { Button } from "./ui/Button";
import type { ConditionalBatchApplyNotice } from "./conditionalBatchSchemeDrafts";

export type ConditionalBatchFooterProps = {
  applyNotice: ConditionalBatchApplyNotice;
  busy: boolean;
  canUndo: boolean;
  conflictCount: number;
  excludedCount: number;
  includedCount: number;
  inspectionOnly: boolean;
  sequenceName: string | null;
  undoLabel: string | null;
  validationMessage: string | null;
  onApply: () => void;
  onUndo: () => void;
};

export function ConditionalBatchFooter(
  props: ConditionalBatchFooterProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <footer className={styles.applyFooter}>
      <div className={styles.applyActions}>
        {props.canUndo ? (
          <Button
            size="sm"
            iconLeft={<IconArrowBackUp size={17} />}
            disabled={props.busy}
            title={props.undoLabel ?? undefined}
            onClick={props.onUndo}
          >
            {t("conditionalBatch.undo")}
          </Button>
        ) : null}
        {props.inspectionOnly ? null : (
          <Button
            variant="primary"
            iconLeft={<IconWand size={18} />}
            disabled={
              props.busy ||
              Boolean(props.validationMessage) ||
              props.includedCount === 0
            }
            onClick={props.onApply}
          >
            {props.sequenceName
              ? t("batchEditorCopy.sequence")
              : t("common.apply")}
          </Button>
        )}
      </div>
    </footer>
  );
}
