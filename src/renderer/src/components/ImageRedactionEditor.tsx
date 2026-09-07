import React from "react";
import { useTranslation } from "react-i18next";
import {
  imageRedactionStamps,
  type ImageRedactionPage,
  type ImageRedactionStroke,
} from "../../../shared/imageRedaction";
import { libraryGateway } from "../api/libraryGateway";
import { Button } from "./ui/Button";
import { NumberField } from "./ui/NumberField";
import { SegmentedControl } from "./ui/SegmentedControl";
import { useContainedPageSize } from "./useContainedPageSize";
import styles from "./ImageRedactionModal.module.css";

export function ImageRedactionEditor({
  page,
  onChange,
  disabled,
  onLoaded,
}: {
  page: ImageRedactionPage;
  onLoaded: (id: string) => void;
  onChange: (strokes: ImageRedactionStroke[]) => void;
  disabled: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const viewport = React.useRef<HTMLDivElement>(null);
  const fit = useContainedPageSize(viewport, page);
  const drawing = useRedactionDrawing(page, onChange);
  const state = {
    ...drawing,
    zoom: drawing.zoom || (fit.width / page.width) * 100,
  };
  const { source, error, zoom, draft, setSource, setError } = state;
  return (
    <>
      <RedactionTools
        page={page}
        disabled={disabled}
        onChange={onChange}
        state={state}
      />
      <div className={styles.viewport} ref={viewport}>
        <svg
          className={styles.image}
          style={{ width: (page.width * zoom) / 100 }}
          viewBox={`0 0 ${page.width} ${page.height}`}
          role="img"
          aria-label={t("imageRedaction.preview")}
          {...redactionPointerHandlers(page, disabled, state)}
        >
          <image
            href={source}
            width={page.width}
            height={page.height}
            onLoad={() => onLoaded(page.id)}
            onError={() => {
              setError(t("codexFonts.imageFailed"));
              setSource("");
            }}
          />
          {[...page.strokes, ...(draft ? [draft] : [])].map((stroke, index) => (
            <RedactionStroke key={index} stroke={stroke} />
          ))}
        </svg>
      </div>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
          <Button onClick={() => state.setRetry((value) => value + 1)}>
            {t("imageRedaction.retry")}
          </Button>
        </p>
      ) : null}
    </>
  );
}

function RedactionStroke({
  stroke,
}: {
  stroke: ImageRedactionStroke;
}): React.JSX.Element {
  const first = stroke.points[0],
    last = stroke.points.at(-1) ?? first;
  if (stroke.shape === "rectangle")
    return (
      <rect
        className={styles.mask}
        x={Math.min(first.x, last.x)}
        y={Math.min(first.y, last.y)}
        width={Math.abs(last.x - first.x)}
        height={Math.abs(last.y - first.y)}
      />
    );
  const radius = stroke.size / 2;
  return (
    <g className={styles.mask}>
      {Array.from(imageRedactionStamps(stroke), ({ x, y }, index) =>
        stroke.shape === "round" ? (
          <circle key={index} cx={x} cy={y} r={radius} />
        ) : (
          <rect
            key={index}
            x={x - radius}
            y={y - radius}
            width={stroke.size}
            height={stroke.size}
          />
        ),
      )}
    </g>
  );
}

function useRedactionDrawing(
  page: ImageRedactionPage,
  onChange: (strokes: ImageRedactionStroke[]) => void,
) {
  const [source, setSource] = React.useState("");
  const [error, setError] = React.useState("");
  const [shape, setShape] =
    React.useState<ImageRedactionStroke["shape"]>("rectangle");
  const [size, setSize] = React.useState(40);
  const [zoom, setZoom] = React.useState(0);
  const [draft, setDraft] = React.useState<ImageRedactionStroke | null>(null);
  const [redo, setRedo] = React.useState<ImageRedactionStroke[]>([]);
  const [retry, setRetry] = React.useState(0);
  React.useEffect(() => {
    setError("");
    setSource("");
    let active = true;
    void libraryGateway
      .getPageImageDataUrl(page.imagePath)
      .then((url) => {
        if (active) setSource(url);
      })
      .catch((failure: unknown) => {
        if (active) setError(String(failure));
      });
    return () => {
      active = false;
    };
  }, [page.imagePath, retry]);
  const position = (event: React.PointerEvent<SVGSVGElement>) => {
    const matrix = event.currentTarget.getScreenCTM()?.inverse();
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(
      matrix,
    );
    return {
      x: Math.max(0, Math.min(page.width, point.x)),
      y: Math.max(0, Math.min(page.height, point.y)),
    };
  };
  const finish = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!draft) return;
    const point = position(event);
    onChange([
      ...page.strokes,
      {
        ...draft,
        points:
          shape === "rectangle"
            ? [draft.points[0], point]
            : [...draft.points, point],
      },
    ]);
    setDraft(null);
    setRedo([]);
  };
  return {
    source,
    setSource,
    error,
    setError,
    shape,
    setShape,
    size,
    setSize,
    zoom,
    setZoom,
    draft,
    setDraft,
    redo,
    setRedo,
    position,
    finish,
    setRetry,
  };
}
function RedactionTools({
  page,
  disabled,
  onChange,
  state,
}: {
  page: ImageRedactionPage;
  disabled: boolean;
  onChange: (strokes: ImageRedactionStroke[]) => void;
  state: ReturnType<typeof useRedactionDrawing>;
}) {
  const { t } = useTranslation("components");
  const { shape, setShape, size, setSize, zoom, setZoom, redo, setRedo } =
    state;
  return (
    <div className={styles.tools}>
      <SegmentedControl
        singleRow
        ariaLabel={t("imageRedaction.shape")}
        value={shape}
        onChange={setShape}
        disabled={disabled}
        options={(["rectangle", "round", "square"] as const).map((id) => ({
          id,
          label: t(`imageRedaction.${id}`),
        }))}
      />
      <NumberField
        className={styles.number}
        variant="framed"
        ariaLabel={t("imageRedaction.size")}
        min={1}
        max={1000}
        value={size}
        onValueChange={setSize}
        disabled={disabled || shape === "rectangle"}
        unit="px"
      />
      <Button
        disabled={disabled || !page.strokes.length}
        onClick={() => {
          setRedo([...redo, page.strokes[page.strokes.length - 1]]);
          onChange(page.strokes.slice(0, -1));
        }}
      >
        {t("imageRedaction.undo")}
      </Button>
      <Button
        disabled={disabled || !redo.length}
        onClick={() => {
          onChange([...page.strokes, redo[redo.length - 1]]);
          setRedo(redo.slice(0, -1));
        }}
      >
        {t("imageRedaction.redo")}
      </Button>
      <NumberField
        className={styles.number}
        variant="framed"
        ariaLabel={t("imageRedaction.zoom")}
        min={1}
        max={400}
        value={zoom}
        onValueChange={setZoom}
        unit="%"
      />
      <Button onClick={() => setZoom(0)}>{t("codexFonts.fit")}</Button>
    </div>
  );
}
function redactionPointerHandlers(
  page: ImageRedactionPage,
  disabled: boolean,
  state: ReturnType<typeof useRedactionDrawing>,
): React.SVGProps<SVGSVGElement> {
  const { source, draft } = state;
  return {
    onPointerDown: (event) => {
      if (
        disabled ||
        !source ||
        event.button !== 0 ||
        page.strokes.length >= 1000
      )
        return;
      event.currentTarget.setPointerCapture(event.pointerId);
      state.setDraft({
        shape: state.shape,
        size: state.size,
        points: [state.position(event)],
      });
    },
    onPointerMove: (event) => {
      if (!draft || draft.points.length >= 19999) return;
      const point = state.position(event);
      state.setDraft({
        ...draft,
        points:
          draft.shape === "rectangle"
            ? [draft.points[0], point]
            : [...draft.points, point],
      });
    },
    onPointerUp: state.finish,
    onPointerCancel: () => state.setDraft(null),
  };
}
