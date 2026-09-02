import React from "react";
import { useTranslation } from "react-i18next";
import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
import type { UiSettings } from "../../../shared/settingsTypes";
import { getBlockModeOptions } from "../lib/blockModeOptions";
import { OptionRow, ToggleOptionRow } from "./TranslationOptionControls";
import { Modal } from "./ui/Modal";
import { TranslationOverwriteWarning } from "./TranslationOverwriteWarning";
import { handoffActiveModalToWorkCenter } from "../lib/modalWorkCenterHandoff";
import { TranslationOptionsActionBar } from "./TranslationOptionsActionBar";

type PageRetranslateModalProps = {
  pageName: string;
  blockCount: number;
  uiSettings: UiSettings | undefined;
  onStart: (
    blockMode: AnalysisBlockMode,
    naturalTextLayout: boolean,
    autoFontMatching: boolean,
    aiFontSizeMatching: boolean,
  ) => void;
  onPersistDefaults: (
    patch: Pick<
      UiSettings,
      | "autoFontMatchingDefault"
      | "aiFontSizeMatchingDefault"
      | "blockModeDefault"
      | "naturalTextLayoutDefault"
    >,
  ) => void;
  onClose: () => void;
};

export function PageRetranslateModal({
  pageName,
  blockCount,
  uiSettings,
  onStart,
  onPersistDefaults,
  onClose,
}: PageRetranslateModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const { t: tRenderer } = useTranslation("renderer");
  const [blockMode, setBlockMode] = React.useState<AnalysisBlockMode>(
    uiSettings?.blockModeDefault ?? "auto",
  );
  const [naturalTextLayout, setNaturalTextLayout] = React.useState(
    uiSettings?.naturalTextLayoutDefault ?? false,
  );
  const [autoFontMatching, setAutoFontMatching] = React.useState(
    uiSettings?.autoFontMatchingDefault ?? false,
  );
  const [aiFontSizeMatching, setAiFontSizeMatching] = React.useState(
    uiSettings?.aiFontSizeMatchingDefault ??
      uiSettings?.fontSizeAutoFitDefault ??
      true,
  );
  const [saveAsDefault, setSaveAsDefault] = React.useState(false);

  const handleStart = (): void => {
    if (saveAsDefault) {
      onPersistDefaults(
        buildRetranslateDefaults(
          blockMode,
          naturalTextLayout,
          autoFontMatching,
          aiFontSizeMatching,
        ),
      );
    }
    handoffActiveModalToWorkCenter();
    onStart(blockMode, naturalTextLayout, autoFontMatching, aiFontSizeMatching);
    onClose();
  };

  return (
    <Modal
      title={t("retranslate.title")}
      size="md"
      onClose={onClose}
      closeOnBackdrop
      maxHeight="900px"
      cardClassName="translation-options-modal"
      footer={
        <TranslationOptionsActionBar
          saveAsDefault={saveAsDefault}
          onCancel={onClose}
          onSaveAsDefaultChange={setSaveAsDefault}
          onStart={handleStart}
          startLabel={t("retranslate.start")}
        />
      }
    >
      <PageRetranslateOptions
        autoFontMatching={autoFontMatching}
        blockCount={blockCount}
        blockMode={blockMode}
        aiFontSizeMatching={aiFontSizeMatching}
        naturalTextLayout={naturalTextLayout}
        onAutoFontMatchingChange={setAutoFontMatching}
        onBlockModeChange={setBlockMode}
        onAiFontSizeMatchingChange={setAiFontSizeMatching}
        onNaturalTextLayoutChange={setNaturalTextLayout}
        pageName={pageName}
        t={t}
        tRenderer={tRenderer}
      />
    </Modal>
  );
}

function buildRetranslateDefaults(
  blockMode: AnalysisBlockMode,
  naturalTextLayout: boolean,
  autoFontMatching: boolean,
  aiFontSizeMatching: boolean,
): Parameters<PageRetranslateModalProps["onPersistDefaults"]>[0] {
  return {
    blockModeDefault: blockMode,
    naturalTextLayoutDefault: naturalTextLayout,
    autoFontMatchingDefault: autoFontMatching,
    aiFontSizeMatchingDefault: aiFontSizeMatching,
  };
}

function PageRetranslateOptions({
  autoFontMatching,
  blockCount,
  blockMode,
  aiFontSizeMatching,
  naturalTextLayout,
  onAutoFontMatchingChange,
  onBlockModeChange,
  onAiFontSizeMatchingChange,
  onNaturalTextLayoutChange,
  pageName,
  t,
  tRenderer,
}: {
  autoFontMatching: boolean;
  blockCount: number;
  blockMode: AnalysisBlockMode;
  aiFontSizeMatching: boolean;
  naturalTextLayout: boolean;
  onAutoFontMatchingChange: (enabled: boolean) => void;
  onBlockModeChange: (mode: AnalysisBlockMode) => void;
  onAiFontSizeMatchingChange: (enabled: boolean) => void;
  onNaturalTextLayoutChange: (enabled: boolean) => void;
  pageName: string;
  t: ReturnType<typeof useTranslation>["t"];
  tRenderer: ReturnType<typeof useTranslation>["t"];
}): React.JSX.Element {
  return (
    <div className="translate-options page-retranslate-options">
      <p className="translate-options-context">
        {t("retranslate.context", { pageName, count: blockCount })}
      </p>
      <OptionRow
        label={t("common.blocks")}
        options={getBlockModeOptions(tRenderer)}
        value={blockMode}
        onChange={onBlockModeChange}
      />
      <p className="translate-options-hint">
        {t(
          blockMode === "keep"
            ? "retranslate.keepBlocksHint"
            : "retranslate.autoBlocksHint",
        )}
      </p>
      <div className="translate-options-toggle-grid">
        <ToggleOptionRow
          label={t("translationOptions.naturalTextLayout")}
          pressed={naturalTextLayout}
          onChange={onNaturalTextLayoutChange}
        />
        <ToggleOptionRow
          label={t("translationOptions.autoFontMatching")}
          pressed={autoFontMatching}
          onChange={onAutoFontMatchingChange}
        />
        <ToggleOptionRow
          label={t("translationOptions.fontSizeAutoFit")}
          pressed={aiFontSizeMatching}
          onChange={onAiFontSizeMatchingChange}
        />
      </div>
      <TranslationOverwriteWarning
        title={t("retranslate.overwriteTitle")}
        description={t("retranslate.overwriteWarning")}
      />
    </div>
  );
}
