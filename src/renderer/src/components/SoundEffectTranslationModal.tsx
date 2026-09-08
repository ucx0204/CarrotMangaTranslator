import {
  ImageTranslationOptions,
  type ImageTranslationChoices,
} from "./ImageTranslationOptions";
import React from "react";
import { useTranslation } from "react-i18next";
import type {
  PrepareSoundEffectTranslationRequest,
  RestoreSoundEffectReviewRequest,
} from "../../../shared/analysisTypes";
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
import { canUseCodexImages } from "../../../shared/codexCapabilities";
import { useCodexConnection } from "../hooks/useCodexConnection";

export type SoundEffectTranslationModalProps = {
  settings?: AppSettings | null;
  sfxRenderingDefault?: "image" | "font";
  chapter: ChapterSnapshot;
  jobActive: boolean;
  autoFontMatchingDefault?: boolean;
  inpaintAfterTranslationDefault?: boolean;
  onClose: () => void;
  onRestore?: (
    request: RestoreSoundEffectReviewRequest,
  ) => Promise<ChapterSnapshot>;
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
  sfxRenderingDefault = "image",
  chapter,
  jobActive,
  autoFontMatchingDefault = false,
  inpaintAfterTranslationDefault = false,
  onClose,
  onRestore,
  onPersistDefaults,
  onStart,
}: SoundEffectTranslationModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const execution = useSoundEffectExecution({
    settings,
    sfxRenderingDefault,
    jobActive,
  });
  const { sfxRendering } = execution;
  const state = useSoundEffectTranslationModalState({
    chapter,
    jobActive,
    autoFontMatchingDefault,
    inpaintAfterTranslationDefault,
    onClose,
    onRestore,
    onPersistDefaults,
    onStart: (request, erase, font) =>
      execution.output === "image" ||
      (erase && execution.eraseEngine === "codex")
        ? onStart(request, erase, sfxRendering === "font" && font, sfxRendering)
        : onStart(request, erase, font),
  });

  const useCodex =
    execution.output === "image" ||
    (state.inpaintAfterTranslation && execution.eraseEngine === "codex");
  const executionDisabled =
    jobActive ||
    state.resetReview.busy ||
    (useCodex && !execution.codexAvailable);
  return (
    <PagePickerModalShell
      title={t("soundEffectReview.modalTitle")}
      width="min(1480px, 100%)"
      closeOnEsc={false}
      onClose={onClose}
      closeDisabled={jobActive || state.resetReview.busy}
      bodyClassName={styles.modalBody}
      footerActions={
        <SoundEffectTranslationActions
          state={state}
          disabled={executionDisabled}
          onClose={onClose}
        />
      }
      footerLeading={
        <SoundEffectTranslationFooter {...execution} state={state} />
      }
    >
      <SoundEffectTranslationReviewPicker
        chapterTitle={chapter.title}
        disabled={jobActive || state.resetReview.busy}
        resetReview={state.resetReview}
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

function SoundEffectTranslationActions({
  state,
  disabled,
  onClose,
}: {
  state: ReturnType<typeof useSoundEffectTranslationModalState>;
  disabled: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation("components");
  return (
    <PagePickerModalActionButtons
      cancel={{
        label: t("common.cancel"),
        onClick: onClose,
        disabled: state.resetReview.busy,
      }}
      confirm={{
        label: t(
          state.includedCount > 0
            ? "soundEffectReview.startSelected"
            : "soundEffectReview.reviewComplete",
          { count: state.includedCount },
        ),
        onClick: state.start,
        disabled: disabled || state.prepareRequest.pages.length === 0,
      }}
    />
  );
}

function useSoundEffectExecution({
  settings,
}: Required<
  Pick<
    SoundEffectTranslationModalProps,
    "settings" | "sfxRenderingDefault" | "jobActive"
  >
>) {
  const [output, setOutput] = React.useState<"text" | "image">("text");
  const [eraseEngine, setEraseEngine] = React.useState<"default" | "codex">(
    "default",
  );
  const { account } = useCodexConnection(Boolean(settings));
  const codexAvailable = canUseCodexImages(settings, account);
  return {
    output,
    setOutput,
    eraseEngine,
    setEraseEngine,
    sfxRendering: output === "image" ? ("image" as const) : ("font" as const),
    codexAvailable,
  };
}

function SoundEffectTranslationFooter({
  output,
  setOutput,
  eraseEngine,
  setEraseEngine,
  codexAvailable,
  state,
}: ReturnType<typeof useSoundEffectExecution> & {
  state: ReturnType<typeof useSoundEffectTranslationModalState>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const change = (value: ImageTranslationChoices) => {
    setOutput(value.output);
    setEraseEngine(value.eraseEngine ?? "default");
    state.setInpaintAfterTranslation(value.eraseOriginal);
  };
  return (
    <div className={styles.executionOptions}>
      <ImageTranslationOptions
        value={{
          output,
          eraseOriginal: state.inpaintAfterTranslation,
          eraseEngine,
        }}
        onChange={change}
        available={codexAvailable}
      />
      {output === "text" ? (
        <PagePickerModalCheckbox
          checked={state.autoFontMatching}
          label={t("translationOptions.autoFontMatching")}
          onCheckedChange={state.setAutoFontMatching}
          variant="switch"
        />
      ) : null}
      <PagePickerModalCheckbox
        checked={state.saveDefaults}
        label={t("soundEffectReview.saveAsDefault")}
        onCheckedChange={state.setSaveDefaults}
      />
    </div>
  );
}
