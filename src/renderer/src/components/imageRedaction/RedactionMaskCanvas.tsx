import React from "react";
import {
  imageRedactionStamps,
  type ImageRedactionStroke,
} from "../../../../shared/imageRedaction";
import { rasterizeImageRedaction } from "../../../../shared/imageRedactionRaster";
import { useEventCallback } from "../../hooks/useEventCallback";
import {
  renderRedactionMaskSurface,
  type RedactionMaskSurface,
} from "./redactionMaskSurface";
import {
  sameRedactionMaskWindow,
  type RedactionMaskWindow,
} from "./redactionMaskWindow";
import styles from "./RedactionWorkspace.module.css";

type Props = {
  width: number;
  height: number;
  strokes: ImageRedactionStroke[];
  draft?: ImageRedactionStroke | null;
  thumbnail?: boolean;
  window?: RedactionMaskWindow;
  onFailure: (error: unknown) => void;
  onReady?: () => void;
};

/** Committed detail masks use exactly the transmitted pixel policy. Only an in-flight stroke is a fast vector preview. */
export function RedactionMaskCanvas(props: Props): React.JSX.Element {
  const {
    width,
    height,
    strokes,
    draft,
    thumbnail,
    window,
    onFailure,
    onReady,
  } = props;
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const surface = useMaskSurface(props);
  const report = useEventCallback(onFailure);
  const ready = useEventCallback(() => onReady?.());
  React.useEffect(() => {
    if (
      !surface ||
      surface.strokes !== strokes ||
      (window && !thumbnail && !sameRedactionMaskWindow(surface.window, window))
    )
      return;
    const target = canvas.current;
    if (!target) return;
    try {
      const source = surface.canvas;
      if (target.width !== source.width || target.height !== source.height) {
        target.width = source.width;
        target.height = source.height;
      }
      const context = target.getContext("2d");
      if (!context) throw new Error("The mask canvas is unavailable");
      context.clearRect(0, 0, target.width, target.height);
      context.drawImage(source, 0, 0);
      if (draft) {
        const shifted = {
          ...draft,
          points: draft.points.map(({ x, y }) => ({
            x: x - surface.window.x,
            y: y - surface.window.y,
          })),
        };
        paintDraft(context, scaleStroke(shifted, 1 / surface.window.factor));
      }
      ready();
    } catch (error) {
      report(error);
    }
  }, [surface, strokes, window, thumbnail, draft, report, ready]);
  const bounds = surface?.window ?? window;
  const style =
    window && bounds && !thumbnail
      ? {
          left: `${(100 * bounds.x) / width}%`,
          top: `${(100 * bounds.y) / height}%`,
          width: `${(100 * bounds.width) / width}%`,
          height: `${(100 * bounds.height) / height}%`,
          right: "auto",
          bottom: "auto",
        }
      : undefined;
  return (
    <canvas
      ref={canvas}
      style={style}
      className={styles.maskCanvas}
      aria-hidden="true"
    />
  );
}

function useMaskSurface(props: Props): RedactionMaskSurface | null {
  const { width, height, strokes, window, thumbnail, onFailure } = props;
  const previous = React.useRef<RedactionMaskSurface | undefined>(undefined);
  const [surface, setSurface] = React.useState<RedactionMaskSurface | null>(
    null,
  );
  const report = useEventCallback(onFailure);
  const scale = Math.min(1, 320 / Math.max(width, height));
  React.useEffect(() => {
    const controller = new AbortController();
    async function build() {
      try {
        const next =
          window && !thumbnail
            ? await renderRedactionMaskSurface(
                { width, height },
                window,
                strokes,
                controller.signal,
                previous.current,
              )
            : {
                canvas: buildMaskCanvas(width, height, strokes, scale),
                strokes,
                window: { x: 0, y: 0, width, height, factor: 1 / scale },
              };
        if (controller.signal.aborted) return;
        previous.current = next;
        setSurface(next);
      } catch (error) {
        if (!controller.signal.aborted) report(error);
      }
    }
    void build();
    return () => controller.abort();
  }, [width, height, strokes, window, thumbnail, scale, report]);
  return surface;
}

function scaleStroke(
  stroke: ImageRedactionStroke,
  scale: number,
): ImageRedactionStroke {
  if (scale === 1) return stroke;
  return {
    ...stroke,
    size: stroke.size * scale,
    points: stroke.points.map(({ x, y }) => ({ x: x * scale, y: y * scale })),
  };
}

function buildMaskCanvas(
  width: number,
  height: number,
  strokes: ImageRedactionStroke[],
  scale: number,
): HTMLCanvasElement {
  const target = document.createElement("canvas");
  target.width = Math.max(1, Math.round(width * scale));
  target.height = Math.max(1, Math.round(height * scale));
  const context = target.getContext("2d");
  if (!context) throw new Error("The mask canvas is unavailable");
  const pixels = rasterizeImageRedaction(
    target.width,
    target.height,
    strokes.map((stroke) => scaleStroke(stroke, scale)),
  );
  const image = context.createImageData(target.width, target.height);
  for (let pixel = 0; pixel < pixels.length; pixel++)
    if (pixels[pixel]) image.data.fill(255, pixel * 4, pixel * 4 + 4);
  context.putImageData(image, 0, 0);
  return target;
}

function paintDraft(
  context: CanvasRenderingContext2D,
  stroke: ImageRedactionStroke,
): void {
  context.save();
  context.globalCompositeOperation =
    stroke.operation === "restore" ? "destination-out" : "source-over";
  // This is outbound pixel data, not application chrome. White is the redaction policy.
  context.fillStyle = "white";
  const first = stroke.points[0];
  const last = stroke.points.at(-1);
  if (first && last && stroke.shape === "rectangle") {
    context.fillRect(
      Math.min(first.x, last.x),
      Math.min(first.y, last.y),
      Math.abs(last.x - first.x),
      Math.abs(last.y - first.y),
    );
  } else {
    for (const { x, y } of imageRedactionStamps(stroke)) {
      if (stroke.shape === "round") {
        context.beginPath();
        context.arc(x, y, stroke.size / 2, 0, Math.PI * 2);
        context.fill();
      } else
        context.fillRect(
          x - stroke.size / 2,
          y - stroke.size / 2,
          stroke.size,
          stroke.size,
        );
    }
  }
  context.restore();
}
