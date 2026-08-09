import React from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./ui/Modal";
import {
  GatherTextControls,
  ReviewWarnings,
} from "./gatherText/GatherTextControls";
import { GatherTextFileInputs } from "./gatherText/GatherTextFileInputs";
import {
  GatherTextFooter,
  GatherTextSearchBar,
} from "./gatherText/GatherTextFooter";
import { GatheredPageList } from "./gatherText/GatheredPageList";
import type { GatherTextModalProps } from "./gatherText/gatherTextTypes";
import { useGatherTextModalModel } from "./gatherText/useGatherTextModalModel";
import { GatherTextFormatSelectionBar } from "./gatherText/GatherTextFormatSelectionBar";

export function GatherTextModal({
  chapter,
  formatApplyDisabled,
  onApplyFormat,
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
    formatApplyDisabled,
    onApplyFormat,
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
      <GatherTextSearchBar search={model.search} />
      <GatherTextControls
        scope={model.scope}
        field={model.field}
        multiSelectAvailable={
          Boolean(model.formatSelection) && model.hasContent
        }
        selectionMode={model.formatSelection?.isSelectionMode ?? false}
        onScopeChange={model.setScope}
        onFieldChange={model.setField}
        onEnterSelectionMode={
          model.formatSelection?.enterSelectionMode ?? (() => undefined)
        }
      />
      <ReviewWarnings warnings={model.reviewWarnings} />
      {model.formatSelection ? (
        <GatherTextFormatSelectionBar selection={model.formatSelection} />
      ) : null}
      <GatheredPageList
        pages={model.pages}
        field={model.field}
        search={model.search}
        formatSelection={model.formatSelection}
        onNavigateToBlock={onNavigateToBlock}
      />
    </Modal>
  );
}
