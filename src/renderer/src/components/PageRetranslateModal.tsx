import React from "react";
import { useTranslation } from "react-i18next";
import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
import type { UiSettings } from "../../../shared/settingsTypes";
import { getBlockModeOptions } from "../lib/blockModeOptions";
import { OptionRow } from "./TranslationOptionsModal";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

export function PageRetranslateModal({
  pageName,
  blockCount,
  uiSettings,
  onStart,
  onPersistDefaults,
  onClose,
}: {
  pageName: string;
  blockCount: number;
  uiSettings: UiSettings | undefined;
  onStart: (blockMode: AnalysisBlockMode) => void;
  onPersistDefaults: (patch: Pick<UiSettings, "blockModeDefault">) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const { t: tRenderer } = useTranslation("renderer");
  const [blockMode, setBlockMode] = React.useState<AnalysisBlockMode>(
    uiSettings?.blockModeDefault ?? "auto",
  );

  const handleStart = (): void => {
    onPersistDefaults({ blockModeDefault: blockMode });
    onStart(blockMode);
    onClose();
  };

  return (
    <Modal
      title={t("retranslate.title")}
      size="md"
      onClose={onClose}
      closeOnBackdrop
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={handleStart}>
            {t("retranslate.start")}
          </Button>
        </>
      }
    >
      <div className="translate-options">
        <p className="translate-options-context">
          {t("retranslate.context", { pageName, count: blockCount })}
        </p>
        <OptionRow
          label={t("common.blocks")}
          options={getBlockModeOptions(tRenderer)}
          value={blockMode}
          onChange={setBlockMode}
        />
        <p className="translate-options-hint">
          {blockMode === "keep"
            ? t("retranslate.keepBlocksHint")
            : t("retranslate.autoBlocksHint")}
        </p>
        <p className="translate-options-hint">
          {t("retranslate.overwriteWarning")}
        </p>
      </div>
    </Modal>
  );
}
