import React from "react";
import { useTranslation } from "react-i18next";
import { SearchReplacePanel } from "./SearchReplacePanel";
import { Modal } from "./ui/Modal";
import { Tabs } from "./ui/Tabs";
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
  activeTab = "overview",
  chapter,
  formatApplyDisabled,
  searchReplaceDisabled,
  onApplyFormat,
  onApplySearchReplace,
  page,
  onClose,
  onTabChange,
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
        activeTab === "overview" ? (
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
        ) : undefined
      }
    >
      <GatherTextTabs active={activeTab} onChange={onTabChange} />
      {activeTab === "overview" ? (
        <GatherTextOverview
          model={model}
          onNavigateToBlock={onNavigateToBlock}
        />
      ) : chapter ? (
        <div
          className="gather-text-tabpanel search-replace-tabpanel"
          id="gather-text-panel-search-replace"
          role="tabpanel"
          aria-labelledby="gather-text-tab-search-replace"
        >
          <SearchReplacePanel
            chapter={chapter}
            disabled={searchReplaceDisabled}
            page={page}
            onApply={onApplySearchReplace ?? (() => undefined)}
            onNavigateToBlock={onNavigateToBlock ?? (() => undefined)}
          />
        </div>
      ) : null}
    </Modal>
  );
}

function GatherTextTabs({
  active,
  onChange,
}: {
  active: NonNullable<GatherTextModalProps["activeTab"]>;
  onChange?: GatherTextModalProps["onTabChange"];
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <Tabs
      className="gather-text-tabs"
      ariaLabel={t("gatherText.tabs.ariaLabel")}
      items={[
        {
          value: "overview",
          label: t("gatherText.tabs.overview"),
          id: "gather-text-tab-overview",
          panelId: "gather-text-panel-overview",
        },
        {
          value: "search-replace",
          label: t("gatherText.tabs.searchReplace"),
          id: "gather-text-tab-search-replace",
          panelId: "gather-text-panel-search-replace",
        },
      ]}
      value={active}
      onChange={onChange ?? (() => undefined)}
    />
  );
}

function GatherTextOverview({
  model,
  onNavigateToBlock,
}: {
  model: ReturnType<typeof useGatherTextModalModel>;
  onNavigateToBlock: GatherTextModalProps["onNavigateToBlock"];
}): React.JSX.Element {
  return (
    <div
      className="gather-text-tabpanel gather-text-overview"
      id="gather-text-panel-overview"
      role="tabpanel"
      aria-labelledby="gather-text-tab-overview"
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
    </div>
  );
}
