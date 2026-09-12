import React from "react";
import { useTranslation } from "react-i18next";
import type { SoundEffectTextReview } from "../../../shared/soundEffectTextReview";
import { libraryGateway } from "../api/libraryGateway";
import { RegionReviewEditor } from "./RegionReviewEditor";
import { useRegionReviewForm } from "./useRegionReviewForm";
import styles from "./SoundEffectTextReviewModal.module.css";

export function SoundEffectTextReviewPage({
  page,
  active,
  busy,
  register,
}: {
  page: SoundEffectTextReview["pages"][number];
  active: boolean;
  busy?: boolean;
  register: (
    pageId: string,
    form: ReturnType<typeof useRegionReviewForm>,
  ) => void;
}) {
  const { t } = useTranslation("components");
  const props = {
    page,
    review: page.review,
    busy,
    bbox: { x: 0, y: 0, w: 1000, h: 1000 },
    editSourceText: true,
  };
  const form = useRegionReviewForm(props);
  const { source, failed, setFailed } = useReviewPageImage(
    page.imagePath,
    active,
  );
  React.useEffect(
    () =>
      register(page.pageId, {
        ...form,
        valid: form.valid && !failed && (!active || !!source),
      }),
    [register, page.pageId, form, failed, active, source],
  );
  return (
    <section className={styles.pane} hidden={!active} aria-label={page.name}>
      {form.error ? <p role="alert">{form.error}</p> : null}
      {failed ? <p role="alert">{t("regionOptions.previewFailed")}</p> : null}
      {active && (
        <RegionReviewEditor
          props={props}
          form={form}
          source={source}
          setFailed={setFailed}
        />
      )}
    </section>
  );
}

function useReviewPageImage(imagePath: string, active: boolean) {
  const [source, setSource] = React.useState("");
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    setSource("");
    if (!active) return;
    setFailed(false);
    void libraryGateway
      .getPageImageDataUrl(imagePath)
      .then((url) => {
        if (alive) setSource(url);
      })
      .catch((error: unknown) => {
        console.error("SFX review preview failed", error);
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [imagePath, active]);
  return { source, failed, setFailed };
}
