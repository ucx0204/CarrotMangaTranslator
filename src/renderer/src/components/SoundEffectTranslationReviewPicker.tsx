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
import { Button } from "./ui/Button";
import { ControlTooltip } from "./ui/ControlTooltip";
import type { useSoundEffectReviewReset } from "./useSoundEffectReviewReset";

type ReviewReset = ReturnType<typeof useSoundEffectReviewReset>;

export function SoundEffectTranslationReviewPicker({
  chapterTitle,
  disabled = false,
  resetReview,
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
  disabled?: boolean;
  resetReview?: ReviewReset;
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
        disabled={disabled}
        resetReview={resetReview}
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
        <div className={styles.reviewLayout} inert={disabled}>
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
  disabled,
  resetReview,
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
  disabled: boolean;
  resetReview?: ReviewReset;
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
      <div className={styles.displayToggles} inert={disabled}>
        <PagePickerModalCheckbox
          checked={showAllPages}
          label={t("soundEffectReview.showAllPages")}
          onCheckedChange={onShowAllPagesChange}
          variant="switch"
        />
        <PagePickerModalCheckbox
          checked={showTranslations}
          label={t("soundEffectReview.showTranslations")}
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
        <Button
          size="sm"
          disabled={disabled || !candidateCount}
          onClick={onSelectAll}
        >
          {t("soundEffectReview.selectAll")}
        </Button>
        <Button
          size="sm"
          disabled={disabled || !selectedCount}
          onClick={onClearAll}
        >
          {t("soundEffectReview.clearAll")}
        </Button>
        {resetReview ? (
          <SoundEffectResetButton disabled={disabled} review={resetReview} />
        ) : null}
      </div>
      <SoundEffectResetFeedback review={resetReview} />
    </header>
  );
}

function SoundEffectResetFeedback({ review }: { review?: ReviewReset }) {
  return (
    <>
      {review?.error ? (
        <span className={styles.resetError} role="alert">
          {review.error}
        </span>
      ) : null}
      <span className="visually-hidden" role="status">
        {review?.feedback}
      </span>
    </>
  );
}

function SoundEffectResetButton({
  disabled,
  review,
}: {
  disabled: boolean;
  review: ReviewReset;
}) {
  const { t } = useTranslation("components");
  return (
    <ControlTooltip
      className={styles.resetTooltip}
      content={t("soundEffectReview.resetHint")}
      placement="bottom"
    >
      <Button
        size="sm"
        disabled={disabled || !review.canReset}
        onClick={review.reset}
      >
        {t(
          review.busy
            ? "soundEffectReview.resetting"
            : "soundEffectReview.reset",
        )}
      </Button>
    </ControlTooltip>
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
