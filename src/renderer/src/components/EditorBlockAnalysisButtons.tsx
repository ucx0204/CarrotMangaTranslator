import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/Button";

export function EditorBlockAnalysisButtons({
  disabled,
  onOcrBlock,
  onTranslateBlock,
  translateDisabled = false,
}: {
  disabled: boolean;
  onOcrBlock?: () => void;
  onTranslateBlock?: () => void;
  translateDisabled?: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (!onOcrBlock && !onTranslateBlock) return null;
  return (
    <div className="editor-block-analysis-buttons">
      <Button
        fullWidth
        size="sm"
        variant="secondary"
        disabled={disabled || !onOcrBlock}
        onClick={onOcrBlock}
      >
        {t("editor.ocrBlock")}
      </Button>
      <Button
        fullWidth
        size="sm"
        variant="secondary"
        disabled={disabled || translateDisabled || !onTranslateBlock}
        onClick={onTranslateBlock}
      >
        {t("editor.translateBlock")}
      </Button>
    </div>
  );
}
