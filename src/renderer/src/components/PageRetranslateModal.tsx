import React from "react";
import { useTranslation } from "react-i18next";
import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
import type { UiSettings } from "../../../shared/settingsTypes";
import { getBlockModeOptions } from "../lib/blockModeOptions";
import { OptionRow, ToggleOptionRow } from "./TranslationOptionControls";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { WarnIcon } from "./ui/icons";

type PageRetranslateModalProps = {
  pageName: string;
  blockCount: number;
  uiSettings: UiSettings | undefined;
  onStart: (
    blockMode: AnalysisBlockMode,
    naturalTextLayout: boolean,
    autoFontMatching: boolean,
  ) => void;
  onPersistDefaults: (
    patch: Pick<
      UiSettings,
      | "autoFontMatchingDefault"
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
  const [saveAsDefault, setSaveAsDefault] = React.useState(false);

  const handleStart = (): void => {
    if (saveAsDefault) {
      onPersistDefaults({
        blockModeDefault: blockMode,
        naturalTextLayoutDefault: naturalTextLayout,
        autoFontMatchingDefault: autoFontMatching,
      });
    }
    onStart(blockMode, naturalTextLayout, autoFontMatching);
    onClose();
  };

  return (
    <Modal
      title={t("retranslate.title")}
      size="md"
      onClose={onClose}
      closeOnBackdrop
      cardClassName="translation-options-modal"
      footer={
        <>
          <label className="translation-save-defaults">
            <input
              type="checkbox"
              checked={saveAsDefault}
              onChange={(event) => setSaveAsDefault(event.target.checked)}
            />
            <span>{t("translationOptions.saveAsDefault")}</span>
          </label>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={handleStart}>
            {t("retranslate.start")}
          </Button>
        </>
      }
    >
      <PageRetranslateOptions
        autoFontMatching={autoFontMatching}
        blockCount={blockCount}
        blockMode={blockMode}
        naturalTextLayout={naturalTextLayout}
        onAutoFontMatchingChange={setAutoFontMatching}
        onBlockModeChange={setBlockMode}
        onNaturalTextLayoutChange={setNaturalTextLayout}
        pageName={pageName}
        t={t}
        tRenderer={tRenderer}
      />
    </Modal>
  );
}

function PageRetranslateOptions({
  autoFontMatching,
  blockCount,
  blockMode,
  naturalTextLayout,
  onAutoFontMatchingChange,
  onBlockModeChange,
  onNaturalTextLayoutChange,
  pageName,
  t,
  tRenderer,
}: {
  autoFontMatching: boolean;
  blockCount: number;
  blockMode: AnalysisBlockMode;
  naturalTextLayout: boolean;
  onAutoFontMatchingChange: (enabled: boolean) => void;
  onBlockModeChange: (mode: AnalysisBlockMode) => void;
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
      </div>
      <div className="translation-overwrite-warning" role="note">
        <WarnIcon size={18} aria-hidden="true" />
        <div>
          <strong>{t("retranslate.overwriteTitle")}</strong>
          <span>{t("retranslate.overwriteWarning")}</span>
        </div>
      </div>
    </div>
  );
}
