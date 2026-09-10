import React from "react";
import {
  imageRedactionStamps,
  type ImageRedactionStroke,
} from "../../../../shared/imageRedaction";
import { rasterizeImageRedaction } from "../../../../shared/imageRedactionRaster";
import { useEventCallback } from "../../hooks/useEventCallback";
import styles from "./RedactionWorkspace.module.css";

type Props = {
  width: number;
  height: number;
  strokes: ImageRedactionStroke[];
  draft?: ImageRedactionStroke | null;
  thumbnail?: boolean;
  onFailure: (error: unknown) => void;
  onReady?: () => void;
};

/** Committed detail masks use exactly the transmitted pixel policy. Only an in-flight stroke is a fast vector preview. */
export function RedactionMaskCanvas({
  width,
  height,
  strokes,
  draft,
  thumbnail,
  onFailure,
  onReady,
}: Props): React.JSX.Element {
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const base = React.useRef<HTMLCanvasElement | null>(null);
  const report = useEventCallback(onFailure);
  const ready = useEventCallback(() => onReady?.());
  const scale = thumbnail ? Math.min(1, 320 / Math.max(width, height)) : 1;
  React.useEffect(() => {
    try {
      base.current = buildMaskCanvas(width, height, strokes, scale);
    } catch (error) {
      base.current = null;
      report(error);
    }
  }, [width, height, strokes, scale, report]);
  React.useEffect(() => {
    const target = canvas.current;
    const source = base.current;
    if (!target || !source) return;
    try {
      target.width = source.width;
      target.height = source.height;
      const context = target.getContext("2d");
      if (!context) throw new Error("The mask canvas is unavailable");
      context.drawImage(source, 0, 0);
      if (draft) paintDraft(context, scaleStroke(draft, scale));
      ready();
    } catch (error) {
      report(error);
    }
  }, [width, height, strokes, draft, scale, report, ready]);
  return (
    <canvas ref={canvas} className={styles.maskCanvas} aria-hidden="true" />
  );
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
