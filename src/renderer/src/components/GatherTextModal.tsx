import React from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./ui";
import {
  GatherTextControls,
  ReviewWarnings,
} from "./gatherText/GatherTextControls";
import { GatherTextFileInputs } from "./gatherText/GatherTextFileInputs";
import { GatherTextFooter } from "./gatherText/GatherTextFooter";
import { GatheredPageList } from "./gatherText/GatheredPageList";
import type { GatherTextModalProps } from "./gatherText/gatherTextTypes";
import { useGatherTextModalModel } from "./gatherText/useGatherTextModalModel";

export function GatherTextModal({
  chapter,
  page,
  onClose,
  onChapterUpdated,
  onApplyTranslatedText,
  onNavigateToBlock,
  readingDirection = "rtl",
}: GatherTextModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const model = useGatherTextModalModel({
    chapter,
    page,
    onChapterUpdated,
    onApplyTranslatedText,
    readingDirection,
  });
  return (
    <Modal
      title={t("gatherText.title")}
      size="lg"
      onClose={onClose}
      closeOnBackdrop
      bodyClassName="gather-text-body"
      footer={
        <GatherTextFooter
          search={model.search}
          excludeHeaders={model.excludeHeaders}
          onToggleExcludeHeaders={model.setExcludeHeaders}
          hasContent={model.hasContent}
          hasChapter={Boolean(chapter)}
          canImportTxt={Boolean(onApplyTranslatedText)}
          reviewBusy={model.reviewBusy}
          onSave={() => void model.handleSave()}
          onCopy={() => void model.handleCopy()}
          onExportReview={(format) => void model.handleExportReview(format)}
          onImportReview={() => model.reviewFileInputRef.current?.click()}
          onImportTxt={() => model.txtFileInputRef.current?.click()}
        />
      }
    >
      <GatherTextFileInputs
        reviewInputRef={model.reviewFileInputRef}
        textInputRef={model.txtFileInputRef}
        onReviewFile={model.handleImportReviewFile}
        onTextFile={model.handleImportTxtFile}
      />
      <GatherTextControls
        scope={model.scope}
        field={model.field}
        onScopeChange={model.setScope}
        onFieldChange={model.setField}
      />
      <ReviewWarnings warnings={model.reviewWarnings} />
      <GatheredPageList
        pages={model.pages}
        field={model.field}
        search={model.search}
        onNavigateToBlock={onNavigateToBlock}
      />
    </Modal>
  );
}
