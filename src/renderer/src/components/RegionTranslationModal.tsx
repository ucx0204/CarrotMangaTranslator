import { normalizedRegionToPixelRect } from "../../../shared/region";
import React from "react";
import { useTranslation } from "react-i18next";
import type { RegionTranslationDialog } from "../lib/regionTranslationOptions";
import { libraryGateway } from "../api/libraryGateway";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { Field, TextField } from "./ui/Field";
import { ToggleOptionRow } from "./TranslationOptionControls";
import { SegmentedControl } from "./ui/SegmentedControl";
import styles from "./RegionTranslationModal.module.css";

export function RegionTranslationModal(
  props: RegionTranslationDialog,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const [choices, setChoices] = React.useState(props.initial);
  const { source, failed, setFailed } = useRegionPreview(props.page);
  const form = useReviewedTexts(props.review);
  const run = () =>
    props.review ? props.onConfirm?.(form.values) : props.onRun(choices);
  const imageAvailable = props.codexImageAvailable ?? props.codexDelegateAll;
  return (
    <Modal
      title={t("regionOptions.title")}
      width="360px"
      onClose={props.onClose}
      footer={
        <RegionActions
          props={props}
          disabled={
            !source ||
            failed ||
            props.busy ||
            regionChoiceUnavailable(props, choices.output, imageAvailable) ||
            (!!props.review && !form.valid)
          }
          run={run}
        />
      }
    >
      <RegionPreview
        page={props.page}
        bbox={props.bbox}
        source={source}
        setFailed={setFailed}
        review={props.review}
        focused={form.focused}
      />
      {failed ? <p role="alert">{t("regionOptions.previewFailed")}</p> : null}
      {props.error ? (
        <p role="alert" className={styles.error}>
          {props.error}
        </p>
      ) : null}
      {props.review ? (
        <ReviewFields review={props.review} form={form} busy={props.busy} />
      ) : (
        <RegionTranslationFields
          choices={choices}
          setChoices={setChoices}
          delegated={props.codexDelegateAll}
          imageAvailable={imageAvailable}
          disabled={props.busy}
        />
      )}
    </Modal>
  );
}

function regionChoiceUnavailable(
  props: RegionTranslationDialog,
  output: "text" | "image",
  imageAvailable: boolean,
) {
  return (
    props.unavailable ||
    ((props.review || output === "image") && !imageAvailable)
  );
}

function RegionActions({
  props,
  disabled,
  run,
}: {
  props: RegionTranslationDialog;
  disabled?: boolean;
  run: () => void;
}) {
  const { t } = useTranslation("components");
  return (
    <div className={styles.actions}>
      <Button variant="secondary" onClick={props.onClose}>
        {t("regionOptions.cancel")}
      </Button>
      <Button variant="primary" disabled={disabled} onClick={run}>
        {props.review
          ? t("regionOptions.generate")
          : props.busy
            ? t("regionOptions.recognizing")
            : t("regionOptions.run")}
      </Button>
    </div>
  );
}
function RegionPreview(
  props: Pick<RegionTranslationDialog, "page" | "bbox" | "review"> & {
    source: string;
    setFailed: (failed: boolean) => void;
    focused?: string;
  },
) {
  const { t } = useTranslation("components");
  const { source, setFailed } = props;
  const crop = normalizedRegionToPixelRect(props.bbox, props.page);
  return (
    <svg
      className={styles.preview}
      viewBox={`${crop.x} ${crop.y} ${crop.w} ${crop.h}`}
      role="img"
      aria-label={t("regionOptions.preview")}
    >
      {source ? (
        <image
          href={source}
          width={props.page.width}
          height={props.page.height}
          onError={() => setFailed(true)}
        />
      ) : null}
      {props.review?.regions
        .filter((region) => region.id === props.focused)
        .map((region) => (
          <rect
            key={region.id}
            className={styles.reviewOutline}
            x={crop.x + (region.sourceBbox.x * crop.w) / 1000}
            y={crop.y + (region.sourceBbox.y * crop.h) / 1000}
            width={(region.sourceBbox.w * crop.w) / 1000}
            height={(region.sourceBbox.h * crop.h) / 1000}
          />
        ))}
    </svg>
  );
}
function ReviewFields({
  review,
  form,
  busy,
}: {
  review: NonNullable<RegionTranslationDialog["review"]>;
  form: ReturnType<typeof useReviewedTexts>;
  busy?: boolean;
}) {
  const { t } = useTranslation("components");
  return (
    <div className={styles.reviewFields}>
      {review.regions.map((region, index) => (
        <Field key={region.id} label={`${index + 1} · ${region.sourceText}`}>
          <TextField
            aria-label={t("regionOptions.translationNumber", {
              number: index + 1,
            })}
            value={
              form.values.find((item) => item.regionId === region.id)?.text ??
              ""
            }
            maxLength={8000}
            disabled={busy}
            onFocus={() => form.setFocused(region.id)}
            onChange={(event) => form.update(region.id, event.target.value)}
          />
        </Field>
      ))}
    </div>
  );
}

function useReviewedTexts(review: RegionTranslationDialog["review"]) {
  const [values, setValues] = React.useState<
    Array<{ regionId: string; text: string }>
  >([]);
  const [focused, setFocused] = React.useState<string>();
  React.useEffect(() => {
    setValues(
      review?.regions.map((region) => ({
        regionId: region.id,
        text: region.translatedText,
      })) ?? [],
    );
    setFocused(review?.regions[0]?.id);
  }, [review]);
  return {
    values,
    focused,
    setFocused,
    valid:
      !!review &&
      values.length === review.regions.length &&
      values.every((item) => item.text.trim().length > 0),
    update: (id: string, text: string) =>
      setValues((previous) =>
        previous.map((item) =>
          item.regionId === id ? { ...item, text } : item,
        ),
      ),
  };
}

function RegionTranslationFields({
  choices,
  setChoices,
  delegated,
  imageAvailable,
  disabled,
}: {
  choices: RegionTranslationDialog["initial"];
  setChoices: (choices: RegionTranslationDialog["initial"]) => void;
  delegated: boolean;
  imageAvailable: boolean;
  disabled?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className={styles.options}>
      {delegated || imageAvailable || choices.output === "image" ? (
        <Field
          className={styles.option}
          labelClassName={styles.optionLabel}
          as="div"
          label={t("regionOptions.output")}
          variant="row"
        >
          <SegmentedControl
            ariaLabel={t("regionOptions.output")}
            value={choices.output}
            disabled={disabled}
            options={[
              {
                id: "text",
                label: t(
                  delegated ? "regionOptions.text" : "regionOptions.standard",
                ),
              },
              {
                id: "image",
                label: t(
                  delegated
                    ? "regionOptions.image"
                    : "regionOptions.imageCodex",
                ),
                disabled: !imageAvailable,
              },
            ]}
            onChange={(output) => setChoices({ ...choices, output })}
          />
        </Field>
      ) : null}
      <ToggleOptionRow
        label={t("regionOptions.erase")}
        pressed={choices.eraseOriginal}
        disabled={disabled}
        onChange={(eraseOriginal) => setChoices({ ...choices, eraseOriginal })}
      />
    </div>
  );
}

function useRegionPreview(page: RegionTranslationDialog["page"]) {
  const [source, setSource] = React.useState(page.dataUrl);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    void libraryGateway
      .getPageImageDataUrl(page.imagePath)
      .then((url) => {
        if (active) setSource(url);
      })
      .catch((error: unknown) => {
        console.error("Region preview failed", error);
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [page.imagePath]);
  return { source, failed, setFailed };
}
