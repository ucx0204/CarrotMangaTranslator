import React from "react";
import { useTranslation } from "react-i18next";
import type { WorkStyleGuide } from "../../../../shared/workContextTypes";
import type { StyleGuideEditorProps } from "./styleGuideTypes";
import { Select } from "../ui/Select";

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
      <Select
        ariaLabel={t("styleGuide.rules.honorifics.label")}
        value={value}
        options={[
          {
            value: "preserve",
            label: t("styleGuide.rules.honorifics.preserve"),
          },
          {
            value: "adapt",
            label: t("styleGuide.rules.honorifics.adapt"),
          },
          {
            value: "drop",
            label: t("styleGuide.rules.honorifics.drop"),
          },
        ]}
        onValueChange={(nextValue) =>
          onChange(nextValue as Rules["honorifics"])
        }
      />
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
      <Select
        ariaLabel={t("styleGuide.rules.sfx.label")}
        value={value}
        options={[
          { value: "preserve", label: t("styleGuide.rules.sfx.preserve") },
          { value: "translate", label: t("styleGuide.rules.sfx.translate") },
          { value: "note", label: t("styleGuide.rules.sfx.note") },
        ]}
        onValueChange={(nextValue) => onChange(nextValue as Rules["sfxMode"])}
      />
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
      <Select
        ariaLabel={t("styleGuide.rules.tone.label")}
        value={value}
        options={[
          {
            value: "natural_korean",
            label: t("styleGuide.rules.tone.natural"),
          },
          { value: "literal", label: t("styleGuide.rules.tone.literal") },
        ]}
        onValueChange={(nextValue) =>
          onChange(nextValue as Rules["defaultTone"])
        }
      />
    </label>
  );
}
