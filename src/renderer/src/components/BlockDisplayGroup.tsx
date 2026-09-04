import React from "react";
import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { BlockBackgroundApplyScope } from "../hooks/useApplyBlockBackgroundOpacityAction";
import { BlockBackgroundApplyModal } from "./BlockBackgroundApplyModal";
import { Button } from "./ui/Button";
import { FieldSlider } from "./ui/FieldSlider";

export function BlockDisplayGroup({
  block,
  disabled,
  disableChapterApply,
  mixed,
  onApply,
  onUpdate,
}: {
  block: TranslationBlock;
  disabled: boolean;
  disableChapterApply: boolean;
  mixed: boolean;
  onApply?: (scope: BlockBackgroundApplyScope) => void;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const [batchOpen, setBatchOpen] = React.useState(false);
  const sliderChangedRef = React.useRef(false);
  const sliderMixedAtPointerDownRef = React.useRef(false);
  const opacityLabel = mixed
    ? t("gatherText.mixedValue")
    : `${Math.round(block.opacity * 100)}%`;
  return (
    <div className="editor-group editor-display-group">
      <div className="editor-group-head">
        <h3>{t("editor.display.title")}</h3>
        {onApply ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => setBatchOpen(true)}
          >
            {t("editor.display.batchApply")}
          </Button>
        ) : null}
      </div>
      <FieldSlider
        label={t("format.blockBackgroundOpacity")}
        valueLabel={opacityLabel}
        aria-valuetext={opacityLabel}
        min={0}
        max={1}
        step={0.01}
        value={block.opacity}
        disabled={disabled}
        onPointerDown={() => {
          sliderChangedRef.current = false;
          sliderMixedAtPointerDownRef.current = mixed;
        }}
        onPointerUp={(event) => {
          if (
            sliderMixedAtPointerDownRef.current &&
            !sliderChangedRef.current
          ) {
            onUpdate({ opacity: Number(event.currentTarget.value) });
          }
          sliderMixedAtPointerDownRef.current = false;
        }}
        onPointerCancel={() => {
          sliderMixedAtPointerDownRef.current = false;
        }}
        onChange={(event) => {
          sliderChangedRef.current = true;
          onUpdate({ opacity: Number(event.target.value) });
        }}
      />
      {batchOpen && onApply ? (
        <BlockBackgroundApplyModal
          disableChapterApply={disableChapterApply}
          onApply={onApply}
          onClose={() => setBatchOpen(false)}
        />
      ) : null}
    </div>
  );
}
