import React from "react";
import { useTranslation } from "react-i18next";
import type { CurveLayout, TranslationBlock } from "../../../shared/textTypes";
import {
  FONT_SIZE_STEP_PX,
  MIN_FONT_SIZE_PX,
  clampFontSizePx,
} from "../../../shared/blockFormatValues";
import { Button } from "./ui/Button";

type CurveUpdate = (patch: Partial<TranslationBlock>) => void;

export function CurveRemoveButton({
  disabled,
  onUpdate,
}: {
  disabled: boolean;
  onUpdate: CurveUpdate;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={disabled}
      onClick={() => onUpdate({ curveLayout: undefined })}
    >
      {t("transform.curve.remove")}
    </Button>
  );
}

export function CurveOverflowWarning({
  block,
  curve,
  disabled,
  overflowPx,
  spacingCanFit,
  onUpdate,
}: {
  block: TranslationBlock;
  curve: CurveLayout;
  disabled: boolean;
  overflowPx: number;
  spacingCanFit: boolean;
  onUpdate: CurveUpdate;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div
      className="transform-overflow-warning"
      role="status"
      aria-live="polite"
    >
      <p>{t("transform.curve.overflow", { amount: overflowPx })}</p>
      <div>
        {!curve.fitSpacing && spacingCanFit ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              onUpdate({ curveLayout: { ...curve, fitSpacing: true } })
            }
          >
            {t("transform.curve.fitAction")}
          </button>
        ) : null}
        <button
          type="button"
          disabled={disabled || block.fontSizePx <= MIN_FONT_SIZE_PX}
          onClick={() =>
            onUpdate({
              fontSizePx: clampFontSizePx(block.fontSizePx - FONT_SIZE_STEP_PX),
              autoFitText: false,
            })
          }
        >
          {t("transform.curve.shrinkText")}
        </button>
      </div>
    </div>
  );
}
