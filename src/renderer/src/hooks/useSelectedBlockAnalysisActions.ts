import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TargetBlockOperation } from "../../../shared/analysisTypes";
import type { BBox } from "../../../shared/textTypes";
import type {
  TranslationActions,
  UseTranslationActionsOptions,
} from "./translationActionTypes";

type RunBlockOperation = (
  bbox: BBox,
  blockId: string,
  operation: TargetBlockOperation,
) => Promise<void>;

export function useSelectedBlockAnalysisActions({
  pushStatus,
  runBlockOperation,
  selectedPage,
}: {
  pushStatus: UseTranslationActionsOptions["pushStatus"];
  runBlockOperation: RunBlockOperation;
  selectedPage: UseTranslationActionsOptions["selectedPage"];
}): Pick<TranslationActions, "ocrSelectedBlock" | "translateSelectedBlock"> {
  const { t } = useTranslation("renderer");
  const run = useCallback(
    async (blockId: string, operation: TargetBlockOperation) => {
      const block = selectedPage?.blocks.find(
        (candidate) => candidate.id === blockId,
      );
      if (!block) {
        pushStatus(t("regionTranslation.blockMissing"));
        return;
      }
      if (operation === "translate" && !block.sourceText.trim()) {
        pushStatus(t("regionTranslation.sourceTextMissing"));
        return;
      }
      await runBlockOperation(block.bbox, block.id, operation);
    },
    [pushStatus, runBlockOperation, selectedPage, t],
  );
  const ocrSelectedBlock = useCallback(
    (blockId: string) => run(blockId, "ocr"),
    [run],
  );
  const translateSelectedBlock = useCallback(
    (blockId: string) => run(blockId, "translate"),
    [run],
  );
  return { ocrSelectedBlock, translateSelectedBlock };
}
