import React from "react";
import { IconFocus2, IconMinus, IconPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { CodexPagePreview } from "../../../shared/codexTypesettingProgress";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { useContainedPageSize } from "./useContainedPageSize";
import styles from "./CodexJobPreview.module.css";
export function CodexPreviewViewer({
  preview,
  url,
  onError,
}: {
  preview: CodexPagePreview;
  url: string;
  onError: () => void;
}) {
  const { t } = useTranslation("components");
  const { viewport, scale, actualScale, drag, setZoom } =
    usePreviewTransform(preview);
  const [regionsVisible, setRegionsVisible] = React.useState(true);
  return (
    <>
      <PreviewToolbar
        preview={preview}
        scale={scale}
        actualScale={actualScale}
        setZoom={setZoom}
        regionsVisible={regionsVisible}
        toggleRegions={() => setRegionsVisible(!regionsVisible)}
      />
      <div className={styles.content}>
        <div
          ref={viewport}
          className={styles.viewport}
          tabIndex={0}
          role="region"
          aria-label={t("codexPreview.image")}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { x: event.clientX, y: event.clientY };
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            event.currentTarget.scrollLeft += drag.current.x - event.clientX;
            event.currentTarget.scrollTop += drag.current.y - event.clientY;
            drag.current = { x: event.clientX, y: event.clientY };
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
        >
          <div className={styles.imageStage}>
            <div
              className={styles.imageFrame}
              style={{
                width: preview.width * actualScale,
                height: preview.height * actualScale,
              }}
            >
              <img
                src={url}
                alt={preview.name}
                draggable={false}
                onError={onError}
              />
              {regionsVisible && <PreviewRegions regions={preview.regions} />}
            </div>
          </div>
        </div>
        <PreviewTranslations regions={preview.regions} />
      </div>
    </>
  );
}

function PreviewToolbar({
  preview,
  scale,
  actualScale,
  setZoom,
  regionsVisible,
  toggleRegions,
}: {
  preview: CodexPagePreview;
  scale: number | null;
  actualScale: number;
  setZoom: (scale: number | null) => void;
  regionsVisible: boolean;
  toggleRegions: () => void;
}) {
  const { t } = useTranslation("components");
  return (
    <header className={styles.toolbar}>
      <strong className={styles.caption}>
        {preview.name} <small>{t(`codexPreview.${preview.stage}`)}</small>
      </strong>
      <div className={styles.zoom}>
        <IconButton
          label={t("codexFonts.zoomOut")}
          disabled={actualScale <= 0.1}
          onClick={() => setZoom(actualScale / 1.25)}
        >
          <IconMinus size={18} />
        </IconButton>
        <span className={styles.percent}>{Math.round(actualScale * 100)}%</span>
        <IconButton
          label={t("codexFonts.zoomIn")}
          disabled={actualScale >= 8}
          onClick={() => setZoom(actualScale * 1.25)}
        >
          <IconPlus size={18} />
        </IconButton>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={scale === null}
          onClick={() => setZoom(null)}
          iconLeft={<IconFocus2 size={18} />}
        >
          {t("codexFonts.fit")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={scale === 1}
          onClick={() => setZoom(1)}
        >
          {t("codexPreview.actualSize")}
        </Button>
        {preview.regions.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={regionsVisible}
            onClick={toggleRegions}
          >
            {t("codexPreview.regions")}
          </Button>
        )}
      </div>
    </header>
  );
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

function usePreviewTransform(preview: CodexPagePreview) {
  const viewport = React.useRef<HTMLDivElement | null>(null);
  const size = useContainedPageSize(viewport, preview);
  const [scale, setScale] = React.useState<number | null>(null);
  const actualScale = scale ?? size.width / Math.max(1, preview.width);
  const drag = React.useRef<{ x: number; y: number } | null>(null);
  const setZoom = (next: number | null) => {
    const node = viewport.current;
    const old = actualScale;
    const value =
      next === null
        ? size.width / Math.max(1, preview.width)
        : Math.max(0.1, Math.min(8, next));
    setScale(next === null ? null : value);
    requestAnimationFrame(() => {
      if (!node) return;
      node.scrollLeft =
        ((node.scrollLeft + node.clientWidth / 2) * value) / old -
        node.clientWidth / 2;
      node.scrollTop =
        ((node.scrollTop + node.clientHeight / 2) * value) / old -
        node.clientHeight / 2;
    });
  };
  return { viewport, scale, actualScale, drag, setZoom };
}

function PreviewTranslations({
  regions,
}: {
  regions: CodexPagePreview["regions"];
}) {
  const { t } = useTranslation("components");
  if (!regions.length) return null;
  return (
    <aside
      className={styles.translationPane}
      aria-label={t("codexPreview.translations")}
    >
      <h3>{t("codexPreview.translations")}</h3>
      <ol className={styles.translations}>
        {regions.map((region, index) => (
          <li key={index}>
            <span>{region.source}</span>
            <p>{region.translation}</p>
          </li>
        ))}
      </ol>
    </aside>
  );
}
