import React from "react";
import { IconAlertTriangle, IconEdit, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  instantiateBlockLibraryEntry,
  type BlockLibraryEntryV1,
} from "../../../shared/blockLibrary";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { BlockFontCatalog } from "../lib/fonts";
import { resolveBlockLibraryThumbnailModel } from "./blockLibraryModel";
import { PageArtwork } from "./PageArtwork";
import { IconButton } from "./ui/IconButton";
import styles from "./BlockLibraryModals.module.css";

export function BlockLibraryCard({
  busy,
  canInsert,
  entry,
  fontCatalog,
  missingFont,
  onDelete,
  onInsert,
  onEdit,
}: {
  busy: boolean;
  canInsert: boolean;
  entry: BlockLibraryEntryV1;
  fontCatalog: BlockFontCatalog;
  missingFont: boolean;
  onDelete: () => void;
  onInsert: () => void;
  onEdit: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <article className={styles.card}>
      <button
        className={styles.cardMain}
        disabled={!canInsert || busy}
        type="button"
        onClick={onInsert}
      >
        <BlockLibraryThumbnail
          entry={entry}
          missingFont={missingFont}
          fontCatalog={fontCatalog}
        />
        <strong className={styles.name}>{entry.name}</strong>
        {missingFont ? (
          <span className={styles.warning}>
            <IconAlertTriangle size={14} aria-hidden="true" />
            {t("blockLibrary.missingFont")}
          </span>
        ) : null}
      </button>
      <div className={styles.cardActions}>
        <IconButton
          size="sm"
          label={t("blockLibrary.edit")}
          disabled={busy}
          onClick={onEdit}
        >
          <IconEdit size={16} aria-hidden="true" />
        </IconButton>
        <IconButton
          size="sm"
          variant="danger"
          label={t("blockLibrary.delete")}
          disabled={busy}
          onClick={onDelete}
        >
          <IconTrash size={16} aria-hidden="true" />
        </IconButton>
      </div>
    </article>
  );
}

function BlockLibraryThumbnail({
  entry,
  fontCatalog,
  missingFont,
}: {
  entry: BlockLibraryEntryV1;
  fontCatalog: BlockFontCatalog;
  missingFont: boolean;
}): React.JSX.Element {
  const block = React.useMemo(() => {
    const next = instantiateBlockLibraryEntry(entry, `preview-${entry.id}`);
    return missingFont ? { ...next, fontFamily: undefined } : next;
  }, [entry, missingFont]);
  return (
    <BlockLibraryArtworkPreview
      block={block}
      className={styles.preview}
      fontCatalog={fontCatalog}
      previewName={entry.name}
    />
  );
}

export function BlockLibraryArtworkPreview({
  block,
  className,
  fontCatalog,
  previewName,
}: {
  block: TranslationBlock;
  className: string;
  fontCatalog: BlockFontCatalog;
  previewName: string;
}): React.JSX.Element {
  const previewRef = React.useRef<HTMLDivElement>(null);
  const artworkRef = React.useRef<HTMLDivElement>(null);
  const previewSize = useSquarePreviewSize(previewRef);
  const model = React.useMemo(
    () => resolveBlockLibraryThumbnailModel(block),
    [block],
  );
  const camera = useRenderedTextPreviewCamera({
    artworkRef,
    block,
    fallbackZoom: model.zoom,
    previewRef,
    previewSize,
  });
  return (
    <div className={className} ref={previewRef} aria-hidden="true">
      <div
        ref={artworkRef}
        className={styles.previewArtwork}
        style={{
          height: previewSize,
          transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`,
          width: previewSize,
        }}
      >
        <PageArtwork
          fontCatalog={fontCatalog}
          imageSrc=""
          page={{
            id: `preview-page-${block.id}`,
            name: previewName,
            width: 1000,
            height: 1000,
            blocks: [model.block],
          }}
          showImage={false}
          visualSize={{ width: previewSize, height: previewSize }}
        />
      </div>
    </div>
  );
}

type PreviewCamera = { x: number; y: number; zoom: number };

function useRenderedTextPreviewCamera({
  artworkRef,
  block,
  fallbackZoom,
  previewRef,
  previewSize,
}: {
  artworkRef: React.RefObject<HTMLDivElement | null>;
  block: TranslationBlock;
  fallbackZoom: number;
  previewRef: React.RefObject<HTMLDivElement | null>;
  previewSize: number;
}): PreviewCamera {
  const [camera, setCamera] = React.useState<PreviewCamera>(() => ({
    x: 0,
    y: 0,
    zoom: fallbackZoom,
  }));
  const cameraRef = React.useRef(camera);
  React.useLayoutEffect(() => {
    cameraRef.current = camera;
  }, [camera]);
  React.useLayoutEffect(() => {
    let active = true;
    let frame = window.requestAnimationFrame(fit);
    const fontReady = document.fonts?.ready;
    if (fontReady) {
      void fontReady.then(() => {
        if (!active) return;
        window.cancelAnimationFrame(frame);
        frame = window.requestAnimationFrame(fit);
      });
    }
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
    };

    function fit(): void {
      if (!active || !artworkRef.current || !previewRef.current) return;
      setPreviewCamera(
        setCamera,
        resolveMeasuredPreviewCamera({
          artwork: artworkRef.current,
          current: cameraRef.current,
          fallbackZoom,
          preview: previewRef.current,
        }),
      );
    }
  }, [artworkRef, block, fallbackZoom, previewRef, previewSize]);
  return camera;
}

function resolveMeasuredPreviewCamera({
  artwork,
  current,
  fallbackZoom,
  preview,
}: {
  artwork: HTMLElement;
  current: PreviewCamera;
  fallbackZoom: number;
  preview: HTMLElement;
}): PreviewCamera {
  const textBounds = measureRenderedTextBounds(artwork);
  const artworkBounds = artwork.getBoundingClientRect();
  const previewBounds = preview.getBoundingClientRect();
  if (
    !textBounds ||
    artworkBounds.width <= 0 ||
    artworkBounds.height <= 0 ||
    current.zoom <= 0
  ) {
    return { x: 0, y: 0, zoom: fallbackZoom };
  }
  const intrinsicWidth = textBounds.width / current.zoom;
  const intrinsicHeight = textBounds.height / current.zoom;
  if (intrinsicWidth <= 0 || intrinsicHeight <= 0) return current;
  const zoom = Math.min(
    48,
    Math.max(
      0.1,
      Math.min(
        (previewBounds.width * 0.72) / intrinsicWidth,
        (previewBounds.height * 0.72) / intrinsicHeight,
      ),
    ),
  );
  const intrinsicOffsetX =
    (textBounds.left +
      textBounds.width / 2 -
      (artworkBounds.left + artworkBounds.width / 2)) /
    current.zoom;
  const intrinsicOffsetY =
    (textBounds.top +
      textBounds.height / 2 -
      (artworkBounds.top + artworkBounds.height / 2)) /
    current.zoom;
  return {
    x: -intrinsicOffsetX * zoom,
    y: -intrinsicOffsetY * zoom,
    zoom,
  };
}

function setPreviewCamera(
  setCamera: React.Dispatch<React.SetStateAction<PreviewCamera>>,
  next: PreviewCamera,
): void {
  setCamera((current) =>
    Math.abs(current.x - next.x) < 0.25 &&
    Math.abs(current.y - next.y) < 0.25 &&
    Math.abs(current.zoom - next.zoom) < 0.005
      ? current
      : next,
  );
}

function measureRenderedTextBounds(root: HTMLElement): DOMRect | null {
  const curveGlyphs = Array.from(
    root.querySelectorAll<SVGTextElement>(".overlay-curve-text text"),
  );
  if (curveGlyphs.length > 0) {
    return unionRects(
      curveGlyphs.map((glyph) => glyph.getBoundingClientRect()),
    );
  }
  const text = root.querySelector<HTMLElement>(".overlay-text-content");
  if (!text || !text.textContent?.trim()) return null;
  const range = document.createRange();
  range.selectNodeContents(text);
  if (typeof range.getBoundingClientRect !== "function") {
    range.detach();
    return null;
  }
  const measured = range.getBoundingClientRect();
  range.detach();
  return measured.width > 0 && measured.height > 0 ? measured : null;
}

function unionRects(rects: readonly DOMRect[]): DOMRect | null {
  const visible = rects.filter((rect) => rect.width > 0 && rect.height > 0);
  if (visible.length === 0) return null;
  const left = Math.min(...visible.map((rect) => rect.left));
  const top = Math.min(...visible.map((rect) => rect.top));
  const right = Math.max(...visible.map((rect) => rect.right));
  const bottom = Math.max(...visible.map((rect) => rect.bottom));
  return DOMRect.fromRect({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  });
}

function useSquarePreviewSize(
  ref: React.RefObject<HTMLDivElement | null>,
): number {
  const [size, setSize] = React.useState(160);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (): void => {
      const next = Math.round(
        Math.min(element.clientWidth || 160, element.clientHeight || 160),
      );
      if (next > 0) setSize((current) => (current === next ? current : next));
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
