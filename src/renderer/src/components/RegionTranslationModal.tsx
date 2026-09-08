import { normalizedRegionToPixelRect } from "../../../shared/region";
import React from "react";
import { useTranslation } from "react-i18next";
import type { RegionTranslationDialog } from "../lib/regionTranslationOptions";
import { libraryGateway } from "../api/libraryGateway";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { RegionReviewEditor } from "./RegionReviewEditor";
import { useRegionReviewForm } from "./useRegionReviewForm";
import { ImageTranslationOptions } from "./ImageTranslationOptions";
import styles from "./RegionTranslationModal.module.css";

export function RegionTranslationModal(
  props: RegionTranslationDialog,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const [choices, setChoices] = React.useState(props.initial);
  const { source, failed, setFailed } = useRegionPreview(props.page);
  const form = useRegionReviewForm(props);
  const run = () => (props.review ? void form.confirm() : props.onRun(choices));
  const imageAvailable = props.codexImageAvailable ?? false;
  return (
    <Modal
      title={t("regionOptions.title")}
      width={props.review ? "96vw" : "360px"}
      fillHeight={!!props.review}
      maxHeight={props.review ? "94vh" : undefined}
      bodyLayout={props.review ? "flex" : "grid"}
      onClose={props.onClose}
      footer={
        <RegionActions
          props={props}
          disabled={regionFormUnavailable(
            props,
            choices,
            imageAvailable,
            form,
            source,
            failed,
          )}
          run={run}
        />
      }
    >
      {props.review ? null : (
        <RegionPreview
          page={props.page}
          bbox={props.bbox}
          source={source}
          setFailed={setFailed}
        />
      )}
      {failed ? <p role="alert">{t("regionOptions.previewFailed")}</p> : null}
      {props.error || form.error ? (
        <p role="alert" className={styles.error}>
          {props.error || form.error}
        </p>
      ) : null}
      {props.review ? (
        <RegionReviewEditor
          props={props}
          form={form}
          source={source}
          setFailed={setFailed}
        />
      ) : (
        <RegionTranslationFields
          choices={choices}
          setChoices={setChoices}
          imageAvailable={imageAvailable}
          disabled={props.busy}
        />
      )}
    </Modal>
  );
}

function regionFormUnavailable(
  props: RegionTranslationDialog,
  choices: RegionTranslationDialog["initial"],
  available: boolean,
  form: ReturnType<typeof useRegionReviewForm>,
  source: string,
  failed: boolean,
) {
  return (
    !source ||
    failed ||
    props.busy ||
    form.preparing ||
    regionChoiceUnavailable(props, choices, available) ||
    (!!props.review && !form.valid)
  );
}

function regionChoiceUnavailable(
  props: RegionTranslationDialog,
  choices: RegionTranslationDialog["initial"],
  imageAvailable: boolean,
) {
  return (
    props.unavailable ||
    ((props.review ||
      choices.output === "image" ||
      (choices.eraseOriginal && choices.eraseEngine === "codex")) &&
      !imageAvailable)
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
  props: Pick<RegionTranslationDialog, "page" | "bbox"> & {
    source: string;
    setFailed: (failed: boolean) => void;
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
    </svg>
  );
}
function RegionTranslationFields({
  choices,
  setChoices,
  imageAvailable,
  disabled,
}: {
  choices: RegionTranslationDialog["initial"];
  setChoices: (choices: RegionTranslationDialog["initial"]) => void;
  imageAvailable: boolean;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <div className={styles.options}>
      <ImageTranslationOptions
        value={choices}
        onChange={setChoices}
        available={imageAvailable}
        disabled={disabled}
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
