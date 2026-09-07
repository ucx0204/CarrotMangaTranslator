import React from "react";
import {
  IconChevronLeft,
  IconChevronRight,
  IconFocus2,
  IconMinus,
  IconPlus,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { MangaPage } from "../../../shared/libraryTypes";
import { libraryGateway } from "../api/libraryGateway";
import { IconButton } from "./ui/IconButton";
import { useContainedPageSize } from "./useContainedPageSize";
import styles from "./CodexFontEditor.module.css";

export function CodexFontPagePreview({
  pages,
  currentPageId,
}: {
  pages: MangaPage[];
  currentPageId?: string | null;
}) {
  const { t } = useTranslation("components");
  const [index, setIndex] = React.useState(() =>
    Math.max(
      0,
      pages.findIndex((page) => page.id === currentPageId),
    ),
  );
  const page = pages[index] ?? pages[0];
  return (
    <section className={styles.preview} aria-label={t("codexFonts.original")}>
      <header className={styles.previewToolbar}>
        <IconButton
          label={t("codexFonts.previousPage")}
          disabled={index === 0}
          onClick={() => setIndex(index - 1)}
        >
          <IconChevronLeft size={18} />
        </IconButton>
        <span>
          {page?.name}{" "}
          <small>
            {index + 1} / {pages.length}
          </small>
        </span>
        <IconButton
          label={t("codexFonts.nextPage")}
          disabled={index >= pages.length - 1}
          onClick={() => setIndex(index + 1)}
        >
          <IconChevronRight size={18} />
        </IconButton>
      </header>
      {page ? <OriginalPage key={page.id} page={page} /> : null}
    </section>
  );
}

function OriginalPage({ page }: { page: MangaPage }) {
  const { t } = useTranslation("components");
  const viewport = React.useRef<HTMLDivElement | null>(null);
  const size = useContainedPageSize(viewport, page);
  const { url, failed } = useOriginalPageSource(page.imagePath);
  const { view, setView, drag, zoom } = usePagePreviewTransform(viewport);
  return (
    <>
      <div
        className={styles.viewport}
        ref={viewport}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerMove={(event) => {
          const previous = drag.current;
          if (!previous) return;
          const x = event.clientX,
            y = event.clientY;
          setView((current) => ({
            ...current,
            x: current.x + x - previous.x,
            y: current.y + y - previous.y,
          }));
          drag.current = { x, y };
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      >
        {url ? (
          <img
            className={styles.originalImage}
            src={url}
            alt={page.name}
            draggable={false}
            style={{
              width: size.width,
              height: size.height,
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
            }}
          />
        ) : (
          <span role="status">
            {t(failed ? "codexFonts.imageFailed" : "common.loading")}
          </span>
        )}
      </div>
      <div className={styles.zoomToolbar}>
        <IconButton
          label={t("codexFonts.zoomOut")}
          onClick={() => zoom(1 / 1.25)}
        >
          <IconMinus size={16} />
        </IconButton>
        <span>{Math.round(view.zoom * 100)}%</span>
        <IconButton label={t("codexFonts.zoomIn")} onClick={() => zoom(1.25)}>
          <IconPlus size={16} />
        </IconButton>
        <IconButton
          label={t("codexFonts.fit")}
          onClick={() => setView({ zoom: 1, x: 0, y: 0 })}
        >
          <IconFocus2 size={18} />
        </IconButton>
      </div>
    </>
  );
}

function useOriginalPageSource(imagePath: string) {
  const [url, setUrl] = React.useState<string>();
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    void libraryGateway
      .getPageImageDataUrl(imagePath)
      .then((source) => {
        if (active) setUrl(source);
      })
      .catch((error: unknown) => {
        console.error(error);
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [imagePath]);
  return { url, failed };
}

function usePagePreviewTransform(
  viewport: React.RefObject<HTMLDivElement | null>,
) {
  const [view, setView] = React.useState({ zoom: 1, x: 0, y: 0 });
  const drag = React.useRef<{ x: number; y: number } | null>(null);
  const zoom = React.useCallback(
    (factor: number) =>
      setView((current) => ({
        ...current,
        zoom: Math.max(0.5, Math.min(8, current.zoom * factor)),
      })),
    [],
  );
  React.useEffect(() => {
    const node = viewport.current;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      zoom(Math.exp(-event.deltaY * 0.002));
    };
    node?.addEventListener("wheel", wheel, { passive: false });
    return () => node?.removeEventListener("wheel", wheel);
  }, [viewport, zoom]);
  return { view, setView, drag, zoom };
}
