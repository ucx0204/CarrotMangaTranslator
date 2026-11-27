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
import { GatherTextDirectFormatModal } from "./gatherText/GatherTextDirectFormatModal";
import { useEventCallback } from "../hooks/useEventCallback";

export function GatherTextModal({
  blockStylePresets,
  chapter,
  formatApplyDisabled,
  onApplyFormat,
  page,
  onClose,
  onImportReviewText,
  onApplyTranslatedText,
  onNavigateToBlock,
  onOpenBatchEdit,
  readingDirection = "rtl",
}: GatherTextModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const applyTranslatedText = useEventCallback(
    (...args: Parameters<NonNullable<typeof onApplyTranslatedText>>) =>
      onApplyTranslatedText?.(...args),
  );
  const importReviewText = useEventCallback(
    (request: Parameters<NonNullable<typeof onImportReviewText>>[0]) => {
      if (!onImportReviewText)
        throw new Error("검수표 가져오기를 사용할 수 없습니다.");
      return onImportReviewText(request);
    },
  );
  const model = useGatherTextModalModel({
    blockStylePresets,
    chapter,
    formatApplyDisabled,
    onApplyFormat,
    page,
    onImportReviewText: onImportReviewText ? importReviewText : undefined,
    onApplyTranslatedText: onApplyTranslatedText
      ? applyTranslatedText
      : undefined,
    readingDirection,
  });
  const overview = (
    <Modal
      title={t("gatherText.title")}
      size="lg"
      onClose={onClose}
      bodyClassName="gather-text-body"
      footer={
        <GatherTextModalFooter
          chapter={chapter}
          model={model}
          mutationDisabled={Boolean(formatApplyDisabled)}
          onApplyTranslatedText={onApplyTranslatedText}
          onClose={onClose}
        />
      }
    >
      <GatherTextOverview
        batchEditDisabled={!chapter || Boolean(formatApplyDisabled)}
        model={model}
        onNavigateToBlock={onNavigateToBlock}
        onOpenBatchEdit={onOpenBatchEdit}
      />
    </Modal>
  );
  const selection = model.formatSelection;
  return (
    <>
      <div hidden={selection?.isFormatModalOpen}>{overview}</div>
      {selection?.isFormatModalOpen ? (
        <GatherTextDirectFormatModal selection={selection} />
      ) : null}
    </>
  );
}

function GatherTextModalFooter({
  chapter,
  model,
  mutationDisabled,
  onApplyTranslatedText,
  onClose,
}: {
  chapter: GatherTextModalProps["chapter"];
  model: ReturnType<typeof useGatherTextModalModel>;
  mutationDisabled: boolean;
  onApplyTranslatedText: GatherTextModalProps["onApplyTranslatedText"];
  onClose: () => void;
}): React.JSX.Element {
  return (
    <GatherTextFooter
      excludeHeaders={model.excludeHeaders}
      onToggleExcludeHeaders={model.setExcludeHeaders}
      hasContent={model.hasContent}
      hasChapter={Boolean(chapter)}
      canImportTxt={Boolean(onApplyTranslatedText)}
      mutationDisabled={mutationDisabled}
      reviewBusy={model.reviewBusy}
      onClose={onClose}
      onSave={() => void model.handleSave()}
      onCopy={() => void model.handleCopy()}
      onExportReview={(format) => void model.handleExportReview(format)}
      onImportReview={() => model.reviewFileInputRef.current?.click()}
      onImportTxt={(field) => {
        model.setTxtImportField(field);
        model.txtFileInputRef.current?.click();
      }}
    />
  );
}

function GatherTextOverview({
  batchEditDisabled,
  model,
  onNavigateToBlock,
  onOpenBatchEdit,
}: {
  batchEditDisabled: boolean;
  model: ReturnType<typeof useGatherTextModalModel>;
  onNavigateToBlock: GatherTextModalProps["onNavigateToBlock"];
  onOpenBatchEdit: GatherTextModalProps["onOpenBatchEdit"];
}): React.JSX.Element {
  return (
    <div className="gather-text-overview">
      <GatherTextFileInputs
        reviewInputRef={model.reviewFileInputRef}
        textInputRef={model.txtFileInputRef}
        onReviewFile={model.handleImportReviewFile}
        onTextFile={model.handleImportTxtFile}
      />
      <GatherTextSearchBar
        disabled={batchEditDisabled || !onOpenBatchEdit}
        search={model.search}
        onOpenBatchEdit={onOpenBatchEdit}
      />
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
    </div>
  );
}
