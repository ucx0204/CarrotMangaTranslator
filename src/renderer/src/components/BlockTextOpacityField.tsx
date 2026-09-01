import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import { NumberField } from "./ui/NumberField";

export function BlockTextOpacityField({
  block,
  disabled,
  onUpdate,
}: {
  block: TranslationBlock;
  disabled: boolean;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const label = t("format.textOpacity");
  return (
    <div className="editor-format-number-cell">
      <span>{label}</span>
      <NumberField
        variant="scrubber"
        ariaLabel={label}
        decreaseLabel={t("format.decreaseValue", { label })}
        increaseLabel={t("format.increaseValue", { label })}
        min={0}
        max={100}
        step={1}
        precision={0}
        value={Math.round((block.textOpacity ?? 1) * 100)}
        disabled={disabled}
        unit="%"
        onValueChange={(value) => onUpdate({ textOpacity: value / 100 })}
      />
    </div>
  );
}
