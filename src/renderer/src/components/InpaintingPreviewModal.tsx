import React from "react";
import { useTranslation } from "react-i18next";
import type { InpaintingPreviewState } from "../hooks/useInpaintingPreview";
import { libraryGateway } from "../api/libraryGateway";
import { Modal } from "./ui/Modal";
import { ModalActionBar, ModalActionButtons } from "./ui/ModalActionBar";

export type InpaintingPreviewModalProps = {
  preview: InpaintingPreviewState;
  busy: boolean;
  error: string | null;
  onApply: () => void;
  onDiscard: () => void;
};

export function InpaintingPreviewModal({
  preview,
  busy,
  error,
  onApply,
  onDiscard,
}: InpaintingPreviewModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const images = usePreviewImages(preview);
  const hasWarnings =
    preview.pagesIncomplete > 0 || preview.blocksIncomplete > 0;

  return (
    <Modal
      title={t("inpainting.preview.title")}
      size="xl"
      closeOnEsc={false}
      bodyClassName="inpainting-preview-modal-body"
      headerExtra={
        <span className="inpainting-preview-badge">
          {t("inpainting.preview.pendingBadge")}
        </span>
      }
      footer={
        <ModalActionBar
          leading={t("inpainting.preview.safeOriginal")}
          actions={
            <ModalActionButtons
              cancel={{
                label: t("inpainting.preview.discard"),
                onClick: onDiscard,
                disabled: busy,
                variant: "secondary",
              }}
              confirm={{
                label: busy
                  ? t("inpainting.preview.applying")
                  : t("inpainting.preview.apply"),
                onClick: onApply,
                disabled: busy,
              }}
            />
          }
        />
      }
    >
      <InpaintingPreviewContent
        preview={preview}
        images={images}
        hasWarnings={hasWarnings}
        error={error}
      />
    </Modal>
  );
}

function InpaintingPreviewContent({
  error,
  hasWarnings,
  images,
  preview,
}: {
  error: string | null;
  hasWarnings: boolean;
  images: ReturnType<typeof usePreviewImages>;
  preview: InpaintingPreviewState;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <div className="inpainting-preview-intro">
        <div>
          <strong>{preview.pageName}</strong>
          <span>{t("inpainting.preview.description")}</span>
        </div>
        <div className="inpainting-preview-stats">
          <span>
            {t("inpainting.preview.pagesChanged", {
              count: preview.pagesChanged,
            })}
          </span>
          <span>
            {t("inpainting.preview.blocksErased", {
              count: preview.blocksErased,
            })}
          </span>
        </div>
      </div>
      <div className="inpainting-preview-compare">
        <PreviewFrame
          label={t("inpainting.preview.before")}
          imageUrl={images.before}
          loading={images.loading}
          alt={t("inpainting.preview.beforeAlt", { page: preview.pageName })}
        />
        <PreviewFrame
          label={t("inpainting.preview.after")}
          imageUrl={images.after}
          loading={images.loading}
          alt={t("inpainting.preview.afterAlt", { page: preview.pageName })}
          emphasized
        />
      </div>
      {hasWarnings ? (
        <p className="inpainting-preview-warning" role="status">
          {t("inpainting.preview.incomplete", {
            count: preview.blocksIncomplete,
          })}
        </p>
      ) : null}
      {images.error ? (
        <p className="inpainting-preview-error" role="alert">
          {t("inpainting.preview.imageFailed")}
        </p>
      ) : null}
      {error ? (
        <p className="inpainting-preview-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

function PreviewFrame({
  alt,
  emphasized = false,
  imageUrl,
  label,
  loading,
}: {
  alt: string;
  emphasized?: boolean;
  imageUrl: string;
  label: string;
  loading: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <figure
      className={`inpainting-preview-frame${emphasized ? " emphasized" : ""}`}
    >
      <figcaption>{label}</figcaption>
      <div aria-busy={loading}>
        {imageUrl ? <img src={imageUrl} alt={alt} draggable={false} /> : null}
        {loading ? (
          <span className="inpainting-preview-loading">
            {t("inpainting.preview.loading")}
          </span>
        ) : null}
      </div>
    </figure>
  );
}

function usePreviewImages(preview: InpaintingPreviewState): {
  before: string;
  after: string;
  loading: boolean;
  error: boolean;
} {
  const [state, setState] = React.useState({
    before: "",
    after: "",
    loading: true,
    error: false,
  });
  React.useEffect(() => {
    const beforePage = preview.beforeChapter.pages.find(
      (page) => page.id === preview.pageId,
    );
    const afterPage = preview.afterChapter.pages.find(
      (page) => page.id === preview.pageId,
    );
    const beforePath = beforePage?.inpaintedImagePath ?? beforePage?.imagePath;
    const afterPath = afterPage?.inpaintedImagePath ?? afterPage?.imagePath;
    if (!beforePath || !afterPath) {
      setState({ before: "", after: "", loading: false, error: true });
      return;
    }
    let active = true;
    setState({ before: "", after: "", loading: true, error: false });
    void Promise.all([
      libraryGateway.getPageImageDataUrl(beforePath),
      libraryGateway.getPageImageDataUrl(afterPath),
    ])
      .then(([before, after]) => {
        if (active) setState({ before, after, loading: false, error: false });
      })
      .catch((loadError: unknown) => {
        console.error(loadError);
        if (active) {
          setState({ before: "", after: "", loading: false, error: true });
        }
      });
    return () => {
      active = false;
    };
  }, [preview]);
  return state;
}
