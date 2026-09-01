import React from "react";
import { useTranslation } from "react-i18next";
import { PagePickerModalCheckbox } from "./PagePickerModalShell";
import { SoundEffectPageList } from "./SoundEffectPageList";
import { SoundEffectPagePreview } from "./SoundEffectPagePreview";
import {
  type SelectedSoundEffectDraftRegion,
  type SoundEffectDraftPage,
} from "./soundEffectTranslationDraftModel";
import {
  useSoundEffectPickerActions,
  useSoundEffectPickerView,
} from "./useSoundEffectReviewPicker";
import styles from "./SoundEffectTranslationModal.module.css";

export function SoundEffectTranslationReviewPicker({
  chapterTitle,
  draftPages,
  selectedRegion,
  showAllPages,
  showTranslations,
  onDraftChange,
  onSelectedRegionChange,
  onShowAllPagesChange,
  onShowTranslationsChange,
}: {
  chapterTitle: string;
  draftPages: SoundEffectDraftPage[];
  selectedRegion: SelectedSoundEffectDraftRegion;
  showAllPages: boolean;
  showTranslations: boolean;
  onDraftChange: React.Dispatch<React.SetStateAction<SoundEffectDraftPage[]>>;
  onSelectedRegionChange: (selection: SelectedSoundEffectDraftRegion) => void;
  onShowAllPagesChange: (checked: boolean) => void;
  onShowTranslationsChange: (checked: boolean) => void;
}): React.JSX.Element {
  const view = useSoundEffectPickerView(draftPages, showAllPages);
  const actions = useSoundEffectPickerActions({
    activePageId: view.activePage?.page.id,
    onDraftChange,
    onRequestedPageChange: view.setRequestedPageId,
    onSelectedRegionChange,
  });
  return (
    <section className={styles.picker}>
      <SoundEffectPickerToolbar
        pageCount={view.visiblePages.length}
        candidateCount={view.candidateCount}
        selectedCount={view.selectedCount}
        showAllPages={showAllPages}
        showTranslations={showTranslations}
        onSelectAll={actions.selectAll}
        onClearAll={actions.clearAll}
        onShowAllPagesChange={onShowAllPagesChange}
        onShowTranslationsChange={onShowTranslationsChange}
      />
      {view.activePage ? (
        <div className={styles.reviewLayout}>
          <SoundEffectPageList
            activePageId={view.activePage.page.id}
            chapterTitle={chapterTitle}
            pages={view.visiblePages}
            onSelectPage={actions.selectPage}
          />
          <SoundEffectPagePreview
            item={view.activePage}
            selectedRegion={selectedRegion}
            showTranslations={showTranslations}
            onCreateRegion={actions.createRegion}
            onSelectedRegionChange={onSelectedRegionChange}
            onToggleRegion={actions.toggleRegion}
            onUpdateRegion={actions.updateRegion}
          />
        </div>
      ) : (
        <SoundEffectReviewComplete />
      )}
    </section>
  );
}

function SoundEffectPickerToolbar({
  pageCount,
  candidateCount,
  selectedCount,
  showAllPages,
  showTranslations,
  onSelectAll,
  onClearAll,
  onShowAllPagesChange,
  onShowTranslationsChange,
}: {
  pageCount: number;
  candidateCount: number;
  selectedCount: number;
  showAllPages: boolean;
  showTranslations: boolean;
  onSelectAll: () => void;
  onClearAll: () => void;
  onShowAllPagesChange: (checked: boolean) => void;
  onShowTranslationsChange: (checked: boolean) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <header className={styles.toolbar}>
      <div className={styles.displayToggles}>
        <PagePickerModalCheckbox
          checked={showAllPages}
          label={t("soundEffectReview.showAllPages", {
            defaultValue: "전체 페이지 표시",
          })}
          onCheckedChange={onShowAllPagesChange}
          variant="switch"
        />
        <PagePickerModalCheckbox
          checked={showTranslations}
          label={t("soundEffectReview.showTranslations", {
            defaultValue: "번역문 표시",
          })}
          onCheckedChange={onShowTranslationsChange}
          variant="switch"
        />
      </div>
      <span className={styles.summary}>
        {t("soundEffectReview.pageSummary", {
          pages: pageCount,
          count: candidateCount,
        })}
        <small>
          {t("soundEffectReview.selectionSummary", {
            selected: selectedCount,
            total: candidateCount,
          })}
        </small>
      </span>
      <div className={styles.toolbarButtons}>
        <button onClick={onSelectAll} type="button">
          {t("soundEffectReview.selectAll")}
        </button>
        <button onClick={onClearAll} type="button">
          {t("soundEffectReview.clearAll")}
        </button>
      </div>
    </header>
  );
}

function SoundEffectReviewComplete(): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className={styles.complete} role="status">
      <strong>{t("soundEffectReview.allComplete")}</strong>
      <span>{t("soundEffectReview.allCompleteHint")}</span>
    </div>
  );
}
