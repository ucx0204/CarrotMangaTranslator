import React from "react";
import { createPortal } from "react-dom";
import { CodexPreviewViewer } from "./CodexPreviewViewer";
import { useTranslation } from "react-i18next";
import type { CodexPagePreview } from "../../../shared/codexTypesettingProgress";
import { libraryGateway } from "../api/libraryGateway";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { useEscapeStackEntry } from "./ui/popupStack";
import {
  usePageThumbnailObserver,
  type ObservePageThumbnail,
} from "./pageThumbnails";
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
              width="min(3600px, 100%)"
              bodyLayout="bare"
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
  const { t } = useTranslation("components");
  const list = React.useRef<HTMLOListElement>(null);
  const observe = usePageThumbnailObserver(list);
  const [selected, setSelected] = React.useState<string | null>(null);
  const latest = history.at(-1);
  const preview =
    history.find((item) => previewKey(item) === selected) ?? latest;
  if (!preview) return null;
  return (
    <div className={styles.workspace}>
      <nav
        className={styles.historyPane}
        aria-label={t("codexPreview.history")}
      >
        <h3>
          {t("codexPreview.history")} <small>{history.length}</small>
        </h3>
        <ol ref={list} className={styles.history}>
          {history.map((item, index) => (
            <HistoryItem
              key={previewKey(item)}
              preview={item}
              observe={observe}
              selected={previewKey(item) === previewKey(preview)}
              index={index}
              onSelect={() =>
                setSelected(item === latest ? null : previewKey(item))
              }
            />
          ))}
        </ol>
      </nav>
      <PreviewEntry key={previewKey(preview)} preview={preview} />
    </div>
  );
}

function previewKey(preview: CodexPagePreview): string {
  return preview.imagePath + preview.stage;
}

function HistoryItem({
  preview,
  observe,
  selected,
  index,
  onSelect,
}: {
  preview: CodexPagePreview;
  observe: ObservePageThumbnail;
  selected: boolean;
  index: number;
  onSelect: () => void;
}) {
  const { t } = useTranslation("components");
  const frame = React.useRef<HTMLLIElement>(null);
  const [visible, setVisible] = React.useState(false);
  React.useEffect(() => {
    if (frame.current) return observe(frame.current, () => setVisible(true));
  }, [observe]);
  React.useEffect(() => {
    if (selected) frame.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  const image = usePreviewImage(preview.imagePath, 0, visible || selected);
  return (
    <li ref={frame}>
      <Button
        variant="ghost"
        className={styles.historyItem}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
      >
        {image.url ? (
          <img
            className={styles.historyThumbnail}
            src={image.url}
            alt=""
            onError={image.fail}
          />
        ) : (
          <span className={styles.historyPlaceholder}>{index + 1}</span>
        )}
        <span className={styles.historyCopy}>
          <strong>{preview.name}</strong>
          <small>{t(`codexPreview.${preview.stage}`)}</small>
        </span>
      </Button>
    </li>
  );
}

function PreviewEntry({ preview }: { preview: CodexPagePreview }) {
  const { t } = useTranslation("components");
  const [reload, setReload] = React.useState(0);
  const image = usePreviewImage(preview.imagePath, reload);
  return (
    <section
      className={styles.entry}
      aria-label={`${preview.name} · ${t(`codexPreview.${preview.stage}`)}`}
    >
      {image.failed ? (
        <div className={styles.empty} role="alert">
          <p>{t("codexFonts.imageFailed")}</p>
          <Button onClick={() => setReload((value) => value + 1)}>
            {t("codexPreview.retry")}
          </Button>
        </div>
      ) : image.url ? (
        <CodexPreviewViewer
          preview={preview}
          url={image.url}
          onError={image.fail}
        />
      ) : (
        <p className={styles.empty} role="status">
          {t("common.loading")}
        </p>
      )}
    </section>
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
