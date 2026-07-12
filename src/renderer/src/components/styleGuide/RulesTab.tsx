import React from "react";
import { useTranslation } from "react-i18next";
import type { WorkStyleGuide } from "../../../../shared/workContextTypes";
import type { StyleGuideEditorProps } from "./styleGuideTypes";

type Rules = WorkStyleGuide["rules"];

export function RulesTab({
  guide,
  onGuideChange,
}: StyleGuideEditorProps): React.JSX.Element {
  const updateRules = (patch: Partial<Rules>): void => {
    onGuideChange({
      ...guide,
      rules: { ...guide.rules, ...patch },
    });
  };
  return (
    <div className="style-guide-content">
      <section className="style-guide-section rules">
        <HonorificRule
          value={guide.rules.honorifics}
          onChange={(honorifics) => updateRules({ honorifics })}
        />
        <SfxRule
          value={guide.rules.sfxMode}
          onChange={(sfxMode) => updateRules({ sfxMode })}
        />
        <ToneRule
          value={guide.rules.defaultTone}
          onChange={(defaultTone) => updateRules({ defaultTone })}
        />
      </section>
    </div>
  );
}

function HonorificRule({
  value,
  onChange,
}: {
  value: Rules["honorifics"];
  onChange: (value: Rules["honorifics"]) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <label>
      {t("styleGuide.rules.honorifics.label")}
      <select
        value={value}
        onChange={(event) =>
          onChange(event.target.value as Rules["honorifics"])
        }
      >
        <option value="preserve">
          {t("styleGuide.rules.honorifics.preserve")}
        </option>
        <option value="adapt">{t("styleGuide.rules.honorifics.adapt")}</option>
        <option value="drop">{t("styleGuide.rules.honorifics.drop")}</option>
      </select>
    </label>
  );
}

function SfxRule({
  value,
  onChange,
}: {
  value: Rules["sfxMode"];
  onChange: (value: Rules["sfxMode"]) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <label>
      {t("styleGuide.rules.sfx.label")}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as Rules["sfxMode"])}
      >
        <option value="preserve">{t("styleGuide.rules.sfx.preserve")}</option>
        <option value="translate">{t("styleGuide.rules.sfx.translate")}</option>
        <option value="note">{t("styleGuide.rules.sfx.note")}</option>
      </select>
    </label>
  );
}

function ToneRule({
  value,
  onChange,
}: {
  value: Rules["defaultTone"];
  onChange: (value: Rules["defaultTone"]) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <label>
      {t("styleGuide.rules.tone.label")}
      <select
        value={value}
        onChange={(event) =>
          onChange(event.target.value as Rules["defaultTone"])
        }
      >
        <option value="natural_korean">
          {t("styleGuide.rules.tone.natural")}
        </option>
        <option value="literal">{t("styleGuide.rules.tone.literal")}</option>
      </select>
    </label>
  );
}
