import React from "react";
import { IconSwitchHorizontal } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { BlockBackgroundApplyScope } from "../hooks/useApplyBlockBackgroundOpacityAction";
import { BlockBackgroundApplyModal } from "./BlockBackgroundApplyModal";
import { ColorField } from "./ColorField";
import { resolveColor, type EditorPanelModel } from "./editorPanelUtils";
import { Button } from "./ui/Button";
import { FieldSlider } from "./ui/FieldSlider";
import { IconButton } from "./ui/IconButton";

type EditorColorGroupProps = {
  block: TranslationBlock;
  disabled: boolean;
  model: EditorPanelModel;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
};

export function EditorColorGroup({
  block,
  disabled,
  model,
  onUpdate,
}: EditorColorGroupProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="editor-group">
      <div className="editor-group-head">
        <h3>{t("format.color")}</h3>
        <IconButton
          size="sm"
          label={t("editor.swapTextOutlineColors")}
          title={t("editor.swapTextOutlineColors")}
          disabled={disabled}
          onClick={() =>
            onUpdate({
              textColor: model.outlineColor,
              outlineColor: resolveColor(block.textColor, "#111111"),
            })
          }
        >
          <IconSwitchHorizontal size={15} stroke={2.1} aria-hidden="true" />
        </IconButton>
      </div>
      <div className="color-row" aria-label={t("editor.blockColors")}>
        <ColorField
          label={t("format.textColor")}
          value={resolveColor(block.textColor, "#111111")}
          disabled={disabled}
          onChange={(textColor) => onUpdate({ textColor })}
        />
        <ColorField
          label={t("format.outline")}
          value={model.outlineColor}
          disabled={disabled}
          onChange={(outlineColor) => onUpdate({ outlineColor })}
        />
      </div>
      <FieldSlider
        label={t("format.outline")}
        valueLabel={`${Math.round((block.outlineWidthScale ?? 1) * 100)}%`}
        min={0}
        max={2.5}
        step={0.1}
        value={block.outlineWidthScale ?? 1}
        disabled={disabled}
        onChange={(event) =>
          onUpdate({ outlineWidthScale: Number(event.target.value) })
        }
      />
    </div>
  );
}

export function BlockDisplayGroup({
  block,
  disabled,
  disableChapterApply,
  onApply,
  onUpdate,
}: {
  block: TranslationBlock;
  disabled: boolean;
  disableChapterApply: boolean;
  onApply?: (scope: BlockBackgroundApplyScope) => void;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const [batchOpen, setBatchOpen] = React.useState(false);
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
        valueLabel={`${Math.round(block.opacity * 100)}%`}
        min={0}
        max={1}
        step={0.01}
        value={block.opacity}
        disabled={disabled}
        onChange={(event) => onUpdate({ opacity: Number(event.target.value) })}
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
