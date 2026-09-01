import React from "react";
import { useTranslation } from "react-i18next";
import type { PrepareSoundEffectTranslationRequest } from "../../../shared/analysisTypes";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { UiSettings } from "../../../shared/settingsTypes";
import {
  PagePickerModalActionButtons,
  PagePickerModalCheckbox,
  PagePickerModalShell,
} from "./PagePickerModalShell";
import { SoundEffectTranslationReviewPicker } from "./SoundEffectTranslationReviewPicker";
import styles from "./SoundEffectTranslationModal.module.css";
import { useSoundEffectTranslationModalState } from "./useSoundEffectTranslationModalState";

export type SoundEffectTranslationModalProps = {
  chapter: ChapterSnapshot;
  jobActive: boolean;
  autoFontMatchingDefault?: boolean;
  inpaintAfterTranslationDefault?: boolean;
  onClose: () => void;
  onPersistDefaults?: (patch: Partial<UiSettings>) => void;
  onStart: (
    request: PrepareSoundEffectTranslationRequest,
    inpaintAfterTranslation: boolean,
    autoFontMatching: boolean,
  ) => void | Promise<void>;
};

export function SoundEffectTranslationModal({
  chapter,
  jobActive,
  autoFontMatchingDefault = false,
  inpaintAfterTranslationDefault = false,
  onClose,
  onPersistDefaults,
  onStart,
}: SoundEffectTranslationModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const state = useSoundEffectTranslationModalState({
    chapter,
    jobActive,
    autoFontMatchingDefault,
    inpaintAfterTranslationDefault,
    onClose,
    onPersistDefaults,
    onStart,
  });

  return (
    <PagePickerModalShell
      title={t("soundEffectReview.modalTitle")}
      size="xl"
      width="min(1480px, 100%)"
      closeOnEsc={false}
      onClose={onClose}
      closeDisabled={jobActive}
      bodyClassName={styles.modalBody}
      footerActions={
        <PagePickerModalActionButtons
          cancel={{ label: t("common.cancel"), onClick: onClose }}
          confirm={{
            label:
              state.includedCount > 0
                ? t("soundEffectReview.startSelected", {
                    count: state.includedCount,
                  })
                : t("soundEffectReview.reviewComplete", {
                    defaultValue: "검토 완료",
                  }),
            onClick: state.start,
            disabled: jobActive || state.prepareRequest.pages.length === 0,
          }}
        />
      }
      footerLeading={
        <SoundEffectTranslationFooter
          inpaintAfterTranslation={state.inpaintAfterTranslation}
          autoFontMatching={state.autoFontMatching}
          saveDefaults={state.saveDefaults}
          onInpaintChange={state.setInpaintAfterTranslation}
          onAutoFontMatchingChange={state.setAutoFontMatching}
          onSaveDefaultsChange={state.setSaveDefaults}
        />
      }
    >
      <SoundEffectTranslationReviewPicker
        chapterTitle={chapter.title}
        draftPages={state.draftPages}
        selectedRegion={state.selectedRegion}
        showAllPages={state.showAllPages}
        showTranslations={state.showTranslations}
        onDraftChange={state.setDraftPages}
        onSelectedRegionChange={state.setSelectedRegion}
        onShowAllPagesChange={state.setShowAllPages}
        onShowTranslationsChange={state.setShowTranslations}
      />
    </PagePickerModalShell>
  );
}

function SoundEffectTranslationFooter({
  inpaintAfterTranslation,
  autoFontMatching,
  saveDefaults,
  onInpaintChange,
  onAutoFontMatchingChange,
  onSaveDefaultsChange,
}: {
  inpaintAfterTranslation: boolean;
  autoFontMatching: boolean;
  saveDefaults: boolean;
  onInpaintChange: (checked: boolean) => void;
  onAutoFontMatchingChange: (checked: boolean) => void;
  onSaveDefaultsChange: (checked: boolean) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className={styles.executionOptions}>
      <div className={styles.executionSwitches}>
        <PagePickerModalCheckbox
          checked={autoFontMatching}
          label={t("translationOptions.autoFontMatching")}
          onCheckedChange={onAutoFontMatchingChange}
          variant="switch"
        />
        <PagePickerModalCheckbox
          checked={inpaintAfterTranslation}
          label={t("soundEffectReview.inpaintAfterTranslation")}
          onCheckedChange={onInpaintChange}
          variant="switch"
        />
      </div>
      <PagePickerModalCheckbox
        checked={saveDefaults}
        label={t("soundEffectReview.saveAsDefault", {
          defaultValue: "다음 번역의 기본값으로 저장",
        })}
        onCheckedChange={onSaveDefaultsChange}
      />
    </div>
  );
}
