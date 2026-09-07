import React from "react";
import { createPortal } from "react-dom";
import { IconFocus2, IconMinus, IconPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { CodexPagePreview } from "../../../shared/codexTypesettingProgress";
import { libraryGateway } from "../api/libraryGateway";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Modal } from "./ui/Modal";
import { useEscapeStackEntry } from "./ui/popupStack";
import {
  usePageThumbnailObserver,
  type ObservePageThumbnail,
} from "./pageThumbnails";
import { useContainedPageSize } from "./useContainedPageSize";
import styles from "./CodexJobPreview.module.css";

/** Read-only snapshots never enter the chapter draft or its autosave path. */
export function CodexJobPreview({
  preview,
  history = [],
}: {
  preview?: CodexPagePreview;
  history?: CodexPagePreview[];
}) {
  const latest = preview ?? history.at(-1);
  return latest ? (
    <LivePreview
      preview={latest}
      history={history.length ? history : [latest]}
    />
  ) : null;
}

function LivePreview({
  preview,
  history,
}: {
  preview: CodexPagePreview;
  history: CodexPagePreview[];
}) {
  const { t } = useTranslation("components");
  const [open, setOpen] = React.useState(false);
  const previewId = React.useId();
  useEscapeStackEntry(open);
  const image = usePreviewImage(preview.imagePath, 0);
  const title = `${preview.name} · ${t(`codexPreview.${preview.stage}`)}`;
  return (
    <>
      <Button
        className={styles.launcher}
        aria-controls={open ? previewId : undefined}
        onClick={() => setOpen(true)}
        iconLeft={
          image.url && (
            <img
              src={image.url}
              alt=""
              className={styles.thumbnail}
              onError={image.fail}
            />
          )
        }
      >
        <span className={styles.copy}>
          <strong>{t("codexPreview.open")}</strong>
          <small>{title}</small>
        </span>
      </Button>
      {open &&
        createPortal(
          <div id={previewId}>
            <Modal
              title={t("codexPreview.open")}
              onClose={() => setOpen(false)}
              size="xl"
              fillHeight
              bodyClassName={styles.body}
            >
              <PreviewHistory history={history} />
            </Modal>
          </div>,
          document.body,
        )}
    </>
  );
}

function PreviewHistory({ history }: { history: CodexPagePreview[] }) {
  const list = React.useRef<HTMLOListElement>(null);
  const observe = usePageThumbnailObserver(list);
  React.useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, []);
  return (
    <ol ref={list} className={styles.history}>
      {history.map((preview) => (
        <PreviewEntry
          key={preview.imagePath + preview.stage}
          preview={preview}
          observe={observe}
        />
      ))}
    </ol>
  );
}

function PreviewEntry({
  preview,
  observe,
}: {
  preview: CodexPagePreview;
  observe: ObservePageThumbnail;
}) {
  const { t } = useTranslation("components");
  const frame = React.useRef<HTMLLIElement>(null);
  const [visible, setVisible] = React.useState(false);
  const [reload, setReload] = React.useState(0);
  React.useEffect(() => {
    if (frame.current) return observe(frame.current, () => setVisible(true));
  }, [observe]);
  const image = usePreviewImage(preview.imagePath, reload, visible);
  return (
    <li ref={frame} className={styles.entry}>
      <p className={styles.caption}>
        {preview.name} · {t(`codexPreview.${preview.stage}`)}
      </p>
      {image.failed ? (
        <div role="alert">
          <p>{t("codexFonts.imageFailed")}</p>
          <Button onClick={() => setReload((value) => value + 1)}>
            {t("codexPreview.retry")}
          </Button>
        </div>
      ) : image.url ? (
        <PreviewContent
          preview={preview}
          url={image.url}
          onError={image.fail}
        />
      ) : (
        <p role="status">{t("common.loading")}</p>
      )}
    </li>
  );
}

function PreviewContent({
  preview,
  url,
  onError,
}: {
  preview: CodexPagePreview;
  url: string;
  onError: () => void;
}) {
  const { t } = useTranslation("components");
  const viewport = React.useRef<HTMLDivElement | null>(null);
  const size = useContainedPageSize(viewport, preview);
  const [zoom, setZoom] = React.useState(1);
  return (
    <>
      <div className={styles.content}>
        <div ref={viewport} className={styles.viewport}>
          <div
            className={styles.imageFrame}
            style={{ width: size.width * zoom, height: size.height * zoom }}
          >
            <img
              src={url}
              alt={preview.name}
              draggable={false}
              onError={onError}
            />
            <PreviewRegions regions={preview.regions} />
          </div>
        </div>
        {preview.regions.length > 0 && (
          <ol className={styles.translations}>
            {preview.regions.map((region, index) => (
              <li key={index}>
                <span>{region.source}</span>
                <p>{region.translation}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className={styles.zoom}>
        <IconButton
          label={t("codexFonts.zoomOut")}
          disabled={zoom <= 0.5}
          onClick={() => setZoom(Math.max(0.5, zoom / 1.25))}
        >
          <IconMinus size={18} />
        </IconButton>
        <span>{Math.round(zoom * 100)}%</span>
        <IconButton
          label={t("codexFonts.zoomIn")}
          disabled={zoom >= 8}
          onClick={() => setZoom(Math.min(8, zoom * 1.25))}
        >
          <IconPlus size={18} />
        </IconButton>
        <IconButton label={t("codexFonts.fit")} onClick={() => setZoom(1)}>
          <IconFocus2 size={18} />
        </IconButton>
      </div>
    </>
  );
}

function usePreviewImage(path: string, reload: number, enabled = true) {
  const [image, setImage] = React.useState({
    path: "",
    url: "",
    failed: false,
  });
  React.useEffect(() => {
    if (!enabled) return;
    let active = true;
    void libraryGateway
      .getPageImageDataUrl(path)
      .then((url) => {
        if (active) setImage({ path, url, failed: !url });
      })
      .catch((error: unknown) => {
        console.error("Codex progress preview failed", error);
        if (active) setImage({ path, url: "", failed: true });
      });
    return () => {
      active = false;
    };
  }, [path, reload, enabled]);
  return {
    ...(image.path === path ? image : { url: "", failed: false }),
    fail: () => setImage({ path, url: "", failed: true }),
  };
}

function PreviewRegions({ regions }: { regions: CodexPagePreview["regions"] }) {
  if (!regions.length) return null;
  return (
    <svg
      className={styles.regions}
      viewBox="0 0 1000 1000"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {regions.map(({ bbox }, index) => (
        <g key={index}>
          <rect x={bbox.x} y={bbox.y} width={bbox.w} height={bbox.h} />
          <text x={bbox.x} y={Math.max(22, bbox.y)}>
            {index + 1}
          </text>
        </g>
      ))}
    </svg>
  );
}
