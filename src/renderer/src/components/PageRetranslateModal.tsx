import React from "react";
import { useTranslation } from "react-i18next";
import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
import type { UiSettings } from "../../../shared/settingsTypes";
import { getBlockModeOptions } from "../lib/blockModeOptions";
import { OptionRow, ToggleOptionRow } from "./TranslationOptionControls";
import { Button } from "./ui/Button";
import { CheckboxField } from "./ui/CheckboxField";
import { Modal } from "./ui/Modal";
import { ModalActionBar } from "./ui/ModalActionBar";
import { TranslationOverwriteWarning } from "./TranslationOverwriteWarning";

type PageRetranslateModalProps = {
  pageName: string;
  blockCount: number;
  uiSettings: UiSettings | undefined;
  onStart: (
    blockMode: AnalysisBlockMode,
    naturalTextLayout: boolean,
    autoFontMatching: boolean,
    fontSizeAutoFit: boolean,
  ) => void;
  onPersistDefaults: (
    patch: Pick<
      UiSettings,
      | "autoFontMatchingDefault"
      | "fontSizeAutoFitDefault"
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
    uiSettings?.naturalTextLayoutDefault ?? true,
  );
  const [autoFontMatching, setAutoFontMatching] = React.useState(
    uiSettings?.autoFontMatchingDefault ?? false,
  );
  const [fontSizeAutoFit, setFontSizeAutoFit] = React.useState(
    uiSettings?.fontSizeAutoFitDefault ?? true,
  );
  const [saveAsDefault, setSaveAsDefault] = React.useState(false);

  const handleStart = (): void => {
    if (saveAsDefault) {
      onPersistDefaults(
        buildRetranslateDefaults(
          blockMode,
          naturalTextLayout,
          autoFontMatching,
          fontSizeAutoFit,
        ),
      );
    }
    onStart(blockMode, naturalTextLayout, autoFontMatching, fontSizeAutoFit);
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
        <PageRetranslateFooter
          saveAsDefault={saveAsDefault}
          onCancel={onClose}
          onSaveAsDefaultChange={setSaveAsDefault}
          onStart={handleStart}
        />
      }
    >
      <PageRetranslateOptions
        autoFontMatching={autoFontMatching}
        blockCount={blockCount}
        blockMode={blockMode}
        fontSizeAutoFit={fontSizeAutoFit}
        naturalTextLayout={naturalTextLayout}
        onAutoFontMatchingChange={setAutoFontMatching}
        onBlockModeChange={setBlockMode}
        onFontSizeAutoFitChange={setFontSizeAutoFit}
        onNaturalTextLayoutChange={setNaturalTextLayout}
        pageName={pageName}
        t={t}
        tRenderer={tRenderer}
      />
    </Modal>
  );
}

function PageRetranslateFooter({
  saveAsDefault,
  onCancel,
  onSaveAsDefaultChange,
  onStart,
}: {
  saveAsDefault: boolean;
  onCancel: () => void;
  onSaveAsDefaultChange: (value: boolean) => void;
  onStart: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <ModalActionBar
      leading={
        <CheckboxField
          className="translation-save-defaults"
          label={t("translationOptions.saveAsDefault")}
          checked={saveAsDefault}
          onCheckedChange={onSaveAsDefaultChange}
        />
      }
      actions={
        <>
          <Button onClick={onCancel}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={onStart}>
            {t("retranslate.start")}
          </Button>
        </>
      }
    />
  );
}

function buildRetranslateDefaults(
  blockMode: AnalysisBlockMode,
  naturalTextLayout: boolean,
  autoFontMatching: boolean,
  fontSizeAutoFit: boolean,
): Parameters<PageRetranslateModalProps["onPersistDefaults"]>[0] {
  return {
    blockModeDefault: blockMode,
    naturalTextLayoutDefault: naturalTextLayout,
    autoFontMatchingDefault: autoFontMatching,
    fontSizeAutoFitDefault: fontSizeAutoFit,
  };
}

function PageRetranslateOptions({
  autoFontMatching,
  blockCount,
  blockMode,
  fontSizeAutoFit,
  naturalTextLayout,
  onAutoFontMatchingChange,
  onBlockModeChange,
  onFontSizeAutoFitChange,
  onNaturalTextLayoutChange,
  pageName,
  t,
  tRenderer,
}: {
  autoFontMatching: boolean;
  blockCount: number;
  blockMode: AnalysisBlockMode;
  fontSizeAutoFit: boolean;
  naturalTextLayout: boolean;
  onAutoFontMatchingChange: (enabled: boolean) => void;
  onBlockModeChange: (mode: AnalysisBlockMode) => void;
  onFontSizeAutoFitChange: (enabled: boolean) => void;
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
          pressed={fontSizeAutoFit}
          onChange={onFontSizeAutoFitChange}
        />
      </div>
      <TranslationOverwriteWarning
        title={t("retranslate.overwriteTitle")}
        description={t("retranslate.overwriteWarning")}
      />
    </div>
  );
}
