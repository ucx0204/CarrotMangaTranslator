import React from "react";
import { useTranslation } from "react-i18next";
import type { OcrPipeline } from "../../../shared/settingsTypes";
import { recommendedOcrPipeline } from "../../../shared/hunyuanOcr";
import { resolveOcrEngineDisplayName } from "../../../shared/ocrEngines";
import { Button } from "./ui/Button";

export function OcrRecommendation({
  sourceLanguage,
  pipeline,
  onApply,
  disabled,
}: {
  sourceLanguage?: string;
  pipeline?: OcrPipeline;
  onApply?: (pipeline: OcrPipeline) => void;
  disabled?: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const recommended = recommendedOcrPipeline(sourceLanguage);
  if (recommended === pipeline) return null;
  return (
    <div className="settings-field-stack">
      <p className="muted-line modal-note">
        {t("settings.hardware.hunyuan.current", {
          engine: resolveOcrEngineDisplayName(pipeline),
        })}
        {" · "}
        {recommended
          ? t("settings.hardware.hunyuan.recommendation", {
              engine: resolveOcrEngineDisplayName(recommended),
            })
          : t("settings.hardware.hunyuan.autoLanguage")}
      </p>
      {!onApply ? (
        <p className="muted-line modal-note">
          {t("ocrRecommendation.settingsHint")}
        </p>
      ) : null}
      {onApply && recommended && recommended !== pipeline ? (
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => onApply(recommended)}
        >
          {t("settings.hardware.hunyuan.apply")}
        </Button>
      ) : null}
    </div>
  );
}
