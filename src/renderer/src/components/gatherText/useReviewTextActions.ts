import React from "react";
import { useTranslation } from "react-i18next";
import type { ChapterSnapshot } from "../../../../shared/libraryTypes";
import type { ReviewExportFormat } from "../../../../shared/reviewTypes";
import { decodeImportedTextContent } from "../../lib/gatherText";
import { toast } from "../../lib/toastStore";
import { gatherTextGateway } from "./gatherTextGateway";

type ReviewActionOptions = {
  chapter: ChapterSnapshot | null;
  onChapterUpdated?: (chapter: ChapterSnapshot) => void;
  setReviewBusy: (busy: boolean) => void;
  setReviewWarnings: (warnings: string[]) => void;
};

export function useReviewTextActions({
  chapter,
  onChapterUpdated,
  setReviewBusy,
  setReviewWarnings,
}: ReviewActionOptions): {
  handleExportReview: (format: ReviewExportFormat) => Promise<void>;
  handleImportReviewFile: (file: File) => Promise<void>;
} {
  const { t } = useTranslation("components");
  const handleExportReview = React.useCallback(
    async (format: ReviewExportFormat) => {
      if (!chapter) return;
      try {
        const result = await gatherTextGateway.exportReviewText({
          chapterId: chapter.id,
          format,
          includeBom: true,
        });
        if (result?.saved) {
          toast.success(t("gatherText.review.saveSuccess"));
        }
      } catch (error) {
        console.error(error);
        toast.error(t("gatherText.review.saveFailed"));
      }
    },
    [chapter, t],
  );

  const handleImportReviewFile = React.useCallback(
    async (file: File) => {
      if (!chapter || !window.confirm(t("gatherText.review.importConfirm"))) {
        return;
      }
      setReviewBusy(true);
      setReviewWarnings([]);
      try {
        const result = await gatherTextGateway.importReviewText({
          chapterId: chapter.id,
          content: decodeImportedTextContent(await file.arrayBuffer()),
          format: file.name.toLowerCase().endsWith(".tsv") ? "tsv" : "csv",
          updateSourceText: false,
          requireSourceMatch: false,
        });
        onChapterUpdated?.(result.chapter);
        setReviewWarnings(result.warnings);
        toast.success(
          t("gatherText.review.updated", {
            count: result.updatedBlockCount,
          }),
        );
        if (result.warnings.length) {
          toast.info(
            t("gatherText.review.warnings", {
              count: result.warnings.length,
            }),
          );
        }
      } catch (error) {
        console.error(error);
        toast.error(t("gatherText.review.importFailed"));
      } finally {
        setReviewBusy(false);
      }
    },
    [chapter, onChapterUpdated, setReviewBusy, setReviewWarnings, t],
  );
  return { handleExportReview, handleImportReviewFile };
}
