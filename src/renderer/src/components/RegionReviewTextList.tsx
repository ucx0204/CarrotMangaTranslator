import React from "react";
import { useTranslation } from "react-i18next";
import { clampBbox } from "../../../shared/bboxNormalization";
import type { RegionReviewInput } from "../lib/regionReviewTypes";
import { Button } from "./ui/Button";
import { Field, TextField } from "./ui/Field";
import { NumberField } from "./ui/NumberField";
import { CheckboxField } from "./ui/CheckboxField";
import { OverflowTooltipText } from "./ui/OverflowTooltipText";
import { useRegionReviewListFocus } from "./useRegionReviewNavigation";
import type { useRegionReviewForm } from "./useRegionReviewForm";
import styles from "./RegionReviewEditor.module.css";
type Form = ReturnType<typeof useRegionReviewForm>;
export function RegionReviewTextList({
  review,
  form,
  disabled,
  crop,
  editSourceText,
}: {
  review: NonNullable<RegionReviewInput["review"]>;
  form: Form;
  disabled?: boolean;
  crop: { w: number; h: number };
  editSourceText?: boolean;
}) {
  const { t } = useTranslation("components");
  const selected = form.values.find((value) => value.regionId === form.focused);
  const fields = useRegionReviewListFocus(form.focused);
  return (
    <div className={styles.fields} ref={fields}>
      {form.values.map((value, index) => (
        <div
          className={styles.textRow}
          key={value.regionId}
          data-selected={form.focused === value.regionId || undefined}
        >
          <Field
            label={`${index + 1} · ${value.sourceText || review.regions.find((region) => region.id === value.regionId)?.sourceText || t("regionOptions.add")}`}
          >
            <TextField
              aria-label={t("regionOptions.translationNumber", {
                number: index + 1,
              })}
              value={value.text}
              maxLength={8000}
              disabled={disabled}
              onFocus={() => form.setFocused(value.regionId)}
              onChange={(event) =>
                form.update(value.regionId, { text: event.target.value })
              }
            />
          </Field>
          {editSourceText && (
            <Field label={t("soundEffectTextReview.source")}>
              <TextField
                aria-label={t("soundEffectTextReview.sourceNumber", {
                  number: index + 1,
                })}
                value={value.sourceText ?? ""}
                maxLength={8000}
                disabled={disabled}
                onFocus={() => form.setFocused(value.regionId)}
                onChange={(event) =>
                  form.update(value.regionId, {
                    sourceText: event.target.value,
                  })
                }
              />
            </Field>
          )}
        </div>
      ))}
      {selected ? (
        <SelectedRegionControls
          selected={selected}
          form={form}
          disabled={disabled}
          crop={crop}
        />
      ) : null}
    </div>
  );
}

function SelectedRegionControls({
  selected,
  form,
  disabled,
  crop,
}: {
  selected: Form["values"][number];
  form: Form;
  disabled?: boolean;
  crop: { w: number; h: number };
}) {
  const { t } = useTranslation("components");
  return (
    <>
      <StyleMatchingControls
        selected={selected}
        form={form}
        disabled={disabled}
      />
      <Button
        size="sm"
        disabled={disabled || form.values.length <= 1}
        onClick={form.removeRegion}
      >
        {t("regionOptions.removeRegion")}
      </Button>
      <div className={styles.geometry}>
        {(["x", "y", "w", "h"] as const).map((key) => {
          const extent = key === "x" || key === "w" ? crop.w : crop.h;
          return (
            <Field key={key} label={t(`regionOptions.box${key}`)}>
              <NumberField
                variant="framed"
                ariaLabel={t(`regionOptions.box${key}`)}
                min={key === "w" || key === "h" ? 1 : 0}
                max={extent}
                value={(selected.sourceBbox[key] * extent) / 1000}
                unit="px"
                disabled={disabled}
                onValueChange={(value) =>
                  form.update(selected.regionId, {
                    sourceBbox: clampBbox({
                      ...selected.sourceBbox,
                      [key]: (value * 1000) / extent,
                    }),
                  })
                }
              />
            </Field>
          );
        })}
      </div>
    </>
  );
}

function StyleMatchingControls({
  selected,
  form,
  disabled,
}: {
  selected: Form["values"][number];
  form: Form;
  disabled?: boolean;
}) {
  const { t } = useTranslation("components");
  if (form.values.length < 2) return null;
  return (
    <Field
      as="div"
      className={styles.styleMatching}
      label={t("regionOptions.matchStyle")}
    >
      <p className={styles.hint}>
        {t("regionOptions.matchStyleHint", {
          number:
            form.values.findIndex(
              (value) => value.regionId === selected.regionId,
            ) + 1,
        })}
      </p>
      <div className={styles.stylePeers}>
        {form.values.map((value, index) =>
          value.regionId === selected.regionId ? null : (
            <CheckboxField
              key={value.regionId}
              className={styles.stylePeer}
              checked={value.styleGroupId === selected.styleGroupId}
              disabled={disabled}
              ariaLabel={t("regionOptions.matchStyleRegion", {
                number: index + 1,
              })}
              label={
                <OverflowTooltipText
                  className={styles.stylePeerText}
                  content={`${index + 1} · ${value.text || value.sourceText || t("regionOptions.add")}`}
                >{`${index + 1} · ${value.text || value.sourceText || t("regionOptions.add")}`}</OverflowTooltipText>
              }
              onCheckedChange={(checked) =>
                form.update(value.regionId, {
                  styleGroupId: checked
                    ? selected.styleGroupId
                    : crypto.randomUUID(),
                })
              }
            />
          ),
        )}
      </div>
    </Field>
  );
}
