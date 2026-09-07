import React from "react";
import { useTranslation } from "react-i18next";
import type { CodexFontPreset } from "../../../shared/codexTypesettingTypes";
import { useFonts } from "../fonts/useFonts";
import { Button } from "./ui/Button";
import { TextField, TextareaField } from "./ui/Field";
import { NumberField } from "./ui/NumberField";
import { SegmentedControl } from "./ui/SegmentedControl";
import { FontSelect } from "./FontSelect";
import styles from "./CodexFontEditor.module.css";

export function CodexFontPresetFields({
  preset,
  onChange,
}: {
  preset: CodexFontPreset;
  onChange: (preset: CodexFontPreset) => void;
}) {
  const { t } = useTranslation("components");
  const [selectedId, select] = React.useState(preset.fonts[0]?.fontId);
  const [adding, setAdding] = React.useState(false);
  const selected =
    preset.fonts.find((font) => font.fontId === selectedId) ?? preset.fonts[0];
  const ids = preset.fonts.map((font) => font.fontId);
  return (
    <>
      <div className={styles.toolbar}>
        <p className={styles.count}>
          {t("codexTypesetting.fontCount", { count: ids.length })}
        </p>
        <Button
          size="sm"
          disabled={ids.length >= 10}
          onClick={() => setAdding(true)}
        >
          {t("codexTypesetting.addFont")}
        </Button>
      </div>
      <PresetFontList
        preset={preset}
        selectedId={selected.fontId}
        onSelect={(id) => {
          select(id);
          setAdding(false);
        }}
      />
      {adding ? (
        <FontSelect
          value=""
          preserveFontId
          excludedIds={ids}
          placeholder={t("codexFonts.chooseFont")}
          ariaLabel={t("codexTypesetting.addFont")}
          onChange={(fontId) => {
            if (!fontId || ids.includes(fontId)) return;
            onChange({
              ...preset,
              fonts: [...preset.fonts, { fontId, purpose: "" }],
            });
            select(fontId);
            setAdding(false);
          }}
        />
      ) : null}
      <CodexFontDetails
        font={selected}
        excludedIds={ids}
        canRemove={ids.length > 1}
        onChange={(font) => {
          onChange({
            ...preset,
            fonts: preset.fonts.map((item) =>
              item.fontId === selected.fontId ? font : item,
            ),
          });
          select(font.fontId);
        }}
        onRemove={() =>
          onChange({
            ...preset,
            fonts: preset.fonts.filter(
              (font) => font.fontId !== selected.fontId,
            ),
          })
        }
      />
    </>
  );
}

function CodexFontDetails({
  font,
  excludedIds,
  canRemove,
  onChange,
  onRemove,
}: {
  font: CodexFontPreset["fonts"][number];
  excludedIds: string[];
  canRemove: boolean;
  onChange: (font: CodexFontPreset["fonts"][number]) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("components");
  const { baseOptions } = useFonts();
  const option = baseOptions.find((item) => item.id === font.fontId);
  return (
    <div className={styles.fontFields}>
      <div className={styles.toolbar}>
        <FontSelect
          value={font.fontId}
          preserveFontId
          excludedIds={excludedIds}
          placeholder={t("codexFonts.missingFont")}
          onChange={(fontId) => {
            if (fontId) onChange({ ...font, fontId });
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={!canRemove}
          onClick={onRemove}
        >
          {t("codexTypesetting.remove")}
        </Button>
      </div>
      {option ? (
        <FontSample family={option.cssFamily} />
      ) : (
        <span className={styles.notice} role="alert">
          {t("codexFonts.replaceMissing")}
        </span>
      )}
      <TextareaField
        label={t("codexTypesetting.purpose")}
        value={font.purpose}
        rows={5}
        maxLength={600}
        placeholder={t("codexTypesetting.purposeHint")}
        onChange={(event) => onChange({ ...font, purpose: event.target.value })}
      />
    </div>
  );
}

function FontSample({ family }: { family: string }) {
  const { t } = useTranslation("components");
  const [text, setText] = React.useState(t("codexFonts.sampleText"));
  const [size, setSize] = React.useState(28);
  const [weight, setWeight] = React.useState<"normal" | "bold">("normal");
  return (
    <>
      <TextField
        label={t("codexFonts.sample")}
        value={text}
        maxLength={200}
        onChange={(event) => setText(event.target.value)}
      />
      <div className={styles.sampleControls}>
        <NumberField
          ariaLabel={t("codexFonts.sampleSize")}
          value={size}
          min={8}
          max={120}
          step={1}
          unit="px"
          onValueChange={setSize}
        />
        <SegmentedControl
          singleRow
          ariaLabel={t("codexFonts.weight")}
          value={weight}
          options={[
            { id: "normal", label: t("codexFonts.normal") },
            { id: "bold", label: t("codexFonts.bold") },
          ]}
          onChange={setWeight}
        />
      </div>
      <div
        className={styles.sample}
        style={{
          fontFamily: family,
          fontSize: size,
          fontWeight: weight,
          fontSynthesis: "weight",
        }}
      >
        {text || t("codexFonts.sampleText")}
      </div>
    </>
  );
}

function PresetFontList({
  preset,
  selectedId,
  onSelect,
}: {
  preset: CodexFontPreset;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation("components");
  const { baseOptions } = useFonts();
  return (
    <div className={styles.list} aria-label={t("codexFonts.fonts")}>
      {preset.fonts.map((font) => (
        <Button
          key={font.fontId}
          size="sm"
          variant={font.fontId === selectedId ? "primary" : "secondary"}
          aria-pressed={font.fontId === selectedId}
          onClick={() => onSelect(font.fontId)}
        >
          {baseOptions.find((option) => option.id === font.fontId)?.label ??
            t("codexFonts.missingFont")}
        </Button>
      ))}
    </div>
  );
}
