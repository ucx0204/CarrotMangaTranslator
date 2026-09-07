import { SegmentedControl } from "./ui/SegmentedControl";
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
import type { AppSettings } from "../../../shared/settingsTypes";
import { canUseCodexTypesetting } from "../../../shared/codexCapabilities";
import { useCodexConnection } from "../hooks/useCodexConnection";

export type SoundEffectTranslationModalProps = {
  settings?: AppSettings | null;
  codexDelegateAll?: boolean;
  codexUnavailable?: boolean;
  sfxRenderingDefault?: "image" | "font";
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
    sfxRendering?: "image" | "font",
  ) => void | Promise<void>;
};

export function SoundEffectTranslationModal({
  settings = null,
  codexDelegateAll = false,
  codexUnavailable = false,
  sfxRenderingDefault = "image",
  chapter,
  jobActive,
  autoFontMatchingDefault = false,
  inpaintAfterTranslationDefault = false,
  onClose,
  onPersistDefaults,
  onStart,
}: SoundEffectTranslationModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const execution = useSoundEffectExecution({
    settings,
    codexDelegateAll,
    codexUnavailable,
    sfxRenderingDefault,
    jobActive,
  });
  const { useCodex, executionDisabled, sfxRendering } = execution;
  const state = useSoundEffectTranslationModalState({
    chapter,
    jobActive: executionDisabled,
    autoFontMatchingDefault: codexDelegateAll ? false : autoFontMatchingDefault,
    inpaintAfterTranslationDefault,
    onClose,
    onPersistDefaults: useCodex ? undefined : onPersistDefaults,
    onStart: (request, erase, font) =>
      useCodex
        ? onStart(request, erase, false, sfxRendering)
        : onStart(request, erase, font),
  });

  return (
    <PagePickerModalShell
      title={t("soundEffectReview.modalTitle")}
      width="min(1480px, 100%)"
      closeOnEsc={false}
      onClose={onClose}
      closeDisabled={jobActive}
      bodyClassName={styles.modalBody}
      footerActions={
        <PagePickerModalActionButtons
          cancel={{ label: t("common.cancel"), onClick: onClose }}
          confirm={{
            label: t(
              state.includedCount > 0
                ? "soundEffectReview.startSelected"
                : "soundEffectReview.reviewComplete",
              { count: state.includedCount },
            ),
            onClick: state.start,
            disabled:
              executionDisabled || state.prepareRequest.pages.length === 0,
          }}
        />
      }
      footerLeading={
        <SoundEffectTranslationFooter
          {...execution}
          showEngine={!codexDelegateAll}
          state={state}
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

function useSoundEffectExecution({
  settings,
  codexDelegateAll,
  codexUnavailable,
  sfxRenderingDefault,
  jobActive,
}: Required<
  Pick<
    SoundEffectTranslationModalProps,
    | "settings"
    | "codexDelegateAll"
    | "codexUnavailable"
    | "sfxRenderingDefault"
    | "jobActive"
  >
>) {
  const [sfxRendering, onSfxRenderingChange] =
    React.useState(sfxRenderingDefault);
  const [engine, onEngineChange] = React.useState<"standard" | "codex">(
    codexDelegateAll ? "codex" : "standard",
  );
  const { account } = useCodexConnection(Boolean(settings));
  const codexAvailable = canUseCodexTypesetting(settings, account, true);
  const useCodex = engine === "codex";
  const executionDisabled =
    jobActive ||
    (useCodex && (codexDelegateAll ? codexUnavailable : !codexAvailable));
  return {
    sfxRendering,
    onSfxRenderingChange,
    engine,
    onEngineChange,
    codexAvailable,
    useCodex,
    executionDisabled,
  };
}

function SoundEffectTranslationFooter({
  useCodex,
  engine,
  onEngineChange,
  codexAvailable,
  showEngine,
  sfxRendering,
  onSfxRenderingChange,
  state,
}: {
  useCodex: boolean;
  engine: "standard" | "codex";
  onEngineChange: (value: "standard" | "codex") => void;
  codexAvailable: boolean;
  showEngine: boolean;
  sfxRendering: "image" | "font";
  onSfxRenderingChange: (value: "image" | "font") => void;
  state: ReturnType<typeof useSoundEffectTranslationModalState>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className={styles.executionOptions}>
      {showEngine && (
        <SegmentedControl
          singleRow
          ariaLabel={t("soundEffectReview.engine")}
          value={engine}
          onChange={onEngineChange}
          options={[
            { id: "standard", label: t("regionOptions.standard") },
            { id: "codex", label: "Codex · Astra", disabled: !codexAvailable },
          ]}
        />
      )}
      <div className={styles.executionSwitches}>
        {useCodex ? (
          <SegmentedControl
            singleRow
            ariaLabel={t("codexTypesetting.sfxRendering")}
            value={sfxRendering}
            onChange={onSfxRenderingChange}
            options={[
              { id: "image", label: t("codexTypesetting.sfxImage") },
              { id: "font", label: t("codexTypesetting.sfxFont") },
            ]}
          />
        ) : (
          <PagePickerModalCheckbox
            checked={state.autoFontMatching}
            label={t("translationOptions.autoFontMatching")}
            onCheckedChange={state.setAutoFontMatching}
            variant="switch"
          />
        )}
        <PagePickerModalCheckbox
          checked={state.inpaintAfterTranslation}
          label={t(
            useCodex
              ? "regionOptions.erase"
              : "soundEffectReview.inpaintAfterTranslation",
          )}
          onCheckedChange={state.setInpaintAfterTranslation}
          variant="switch"
        />
      </div>
      {!useCodex && (
        <PagePickerModalCheckbox
          checked={state.saveDefaults}
          label={t("soundEffectReview.saveAsDefault", {
            defaultValue: "다음 번역의 기본값으로 저장",
          })}
          onCheckedChange={state.setSaveDefaults}
        />
      )}
    </div>
  );
}
