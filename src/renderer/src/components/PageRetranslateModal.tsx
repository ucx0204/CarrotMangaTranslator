import React from "react";
import { useTranslation } from "react-i18next";
import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
import type { UiSettings } from "../../../shared/settingsTypes";
import { getBlockModeOptions } from "../lib/blockModeOptions";
import { OptionRow } from "./TranslationOptionControls";
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
  onStart: (blockMode: AnalysisBlockMode, naturalTextLayout: boolean) => void;
  onPersistDefaults: (
    patch: Pick<UiSettings, "blockModeDefault" | "naturalTextLayoutDefault">,
  ) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const { t: tRenderer } = useTranslation("renderer");
  const [blockMode, setBlockMode] = React.useState<AnalysisBlockMode>(
    uiSettings?.blockModeDefault ?? "auto",
  );
  const [naturalTextLayout, setNaturalTextLayout] = React.useState(
    uiSettings?.naturalTextLayoutDefault ?? true,
  );

  const handleStart = (): void => {
    onPersistDefaults({
      blockModeDefault: blockMode,
      naturalTextLayoutDefault: naturalTextLayout,
    });
    onStart(blockMode, naturalTextLayout);
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
        <NaturalTextLayoutOption
          enabled={naturalTextLayout}
          onChange={setNaturalTextLayout}
        />
        <p className="translate-options-hint">
          {t("retranslate.overwriteWarning")}
        </p>
      </div>
    </Modal>
  );
}

function NaturalTextLayoutOption({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <OptionRow
        label={t("translationOptions.naturalTextLayout")}
        options={[
          { id: "off", label: t("translationOptions.naturalTextLayoutOff") },
          { id: "on", label: t("translationOptions.naturalTextLayoutOn") },
        ]}
        value={enabled ? "on" : "off"}
        onChange={(value) => onChange(value === "on")}
      />
      <p className="translate-options-hint">
        {t("translationOptions.naturalTextLayoutHint")}
      </p>
    </>
  );
}
