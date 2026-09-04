import { IconSwitchHorizontal } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { PanelFormatFieldKey } from "../../../shared/panelBridgeTypes";
import { ColorField } from "./ColorField";
import { EditorOutlineControls } from "./EditorOutlineControls";
import { resolveColor, type EditorPanelModel } from "./editorPanelUtils";
import { CheckboxField } from "./ui/CheckboxField";
import { IconButton } from "./ui/IconButton";

type EditorColorGroupProps = {
  block: TranslationBlock;
  disabled: boolean;
  mixedFields?: ReadonlySet<PanelFormatFieldKey>;
  model: EditorPanelModel;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
};

export function EditorColorGroup({
  block,
  disabled,
  mixedFields = EMPTY_MIXED_FIELDS,
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
            mixed={mixedFields.has("textColor")}
            onChange={(textColor) => onUpdate({ textColor })}
          />
        </div>
        <TextBackgroundField
          block={block}
          disabled={disabled}
          mixedFields={mixedFields}
          onUpdate={onUpdate}
        />
        <EditorOutlineControls
          block={block}
          disabled={disabled}
          mixedFields={mixedFields}
          outlineColor={model.outlineColor}
          onUpdate={onUpdate}
        />
      </div>
    </div>
  );
}

function TextBackgroundField({
  block,
  disabled,
  mixedFields,
  onUpdate,
}: {
  block: TranslationBlock;
  disabled: boolean;
  mixedFields: ReadonlySet<PanelFormatFieldKey>;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const enabledMixed = mixedFields.has("textBackgroundEnabled");
  return (
    <div className="editor-appearance-row">
      <CheckboxField
        className="editor-appearance-toggle"
        label={t("format.textBackground.enabled")}
        checked={Boolean(block.textBackgroundEnabled)}
        indeterminate={enabledMixed}
        disabled={disabled}
        onCheckedChange={(enabled) =>
          onUpdate({
            textBackgroundEnabled: enabledMixed || enabled,
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
          mixed={mixedFields.has("textBackgroundColor")}
          onChange={(textBackgroundColor) => onUpdate({ textBackgroundColor })}
        />
      ) : null}
    </div>
  );
}

const EMPTY_MIXED_FIELDS: ReadonlySet<PanelFormatFieldKey> = new Set();
