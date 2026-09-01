import { IconSwitchHorizontal } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import { ColorField } from "./ColorField";
import { EditorOutlineControls } from "./EditorOutlineControls";
import { resolveColor, type EditorPanelModel } from "./editorPanelUtils";
import { CheckboxField } from "./ui/CheckboxField";
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
    <div className="editor-group editor-appearance-group">
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
      <div
        className="editor-appearance-list"
        aria-label={t("editor.blockColors")}
      >
        <div className="editor-appearance-row">
          <span className="editor-appearance-label">
            {t("format.textColor")}
          </span>
          <ColorField
            className="editor-appearance-color"
            label={t("format.textColor")}
            labelHidden
            value={resolveColor(block.textColor, "#111111")}
            disabled={disabled}
            onChange={(textColor) => onUpdate({ textColor })}
          />
        </div>
        <div className="editor-appearance-row">
          <CheckboxField
            className="editor-appearance-toggle"
            label={t("format.textBackground.enabled")}
            checked={Boolean(block.textBackgroundEnabled)}
            disabled={disabled}
            onCheckedChange={(textBackgroundEnabled) =>
              onUpdate({
                textBackgroundEnabled,
                textBackgroundColor: block.textBackgroundColor ?? "#ffffff",
              })
            }
          />
          {block.textBackgroundEnabled ? (
            <ColorField
              className="editor-appearance-color"
              label={t("format.textBackground.color")}
              labelHidden
              value={resolveColor(block.textBackgroundColor, "#ffffff")}
              disabled={disabled}
              onChange={(textBackgroundColor) =>
                onUpdate({ textBackgroundColor })
              }
            />
          ) : null}
        </div>
        <EditorOutlineControls
          block={block}
          disabled={disabled}
          outlineColor={model.outlineColor}
          onUpdate={onUpdate}
        />
      </div>
    </div>
  );
}
