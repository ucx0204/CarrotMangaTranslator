import React from "react";
import { useTranslation } from "react-i18next";
import { letteringMaskSvg } from "../../../shared/generatedLetteringMask";
import type { BBox, Point } from "../../../shared/textTypes";
import type { RegionTranslationDialog } from "../lib/regionTranslationOptions";
import { RegionSelectionOverlay } from "./ui/RegionSelectionOverlay";
import type { useRegionReviewForm } from "./useRegionReviewForm";
import styles from "./RegionReviewEditor.module.css";
import {
  type RegionReviewTool,
  useReviewDrawing,
  regionReviewPosition,
} from "./useRegionReviewDrawing";
import { CircularBrushCursor } from "./CircularBrushCursor";
import { useSoundEffectPageEditor } from "./useSoundEffectPageEditor";
import { useRegionReviewBoxGestures } from "./useRegionReviewBoxGestures";
import { paintedSelectionSvg } from "../lib/regionReviewSelection";

type Form = ReturnType<typeof useRegionReviewForm>;
type Props = {
  page: RegionTranslationDialog["page"];
  crop: { x: number; y: number; w: number; h: number };
  source: string;
  form: Form;
  disabled?: boolean;
  tool: RegionReviewTool;
  shape: "circle" | "square";
  size: number;
  zoom: number;
  setFailed: (value: boolean) => void;
};

export function RegionReviewCanvas({
  viewport,
  ...props
}: Props & {
  viewport: React.RefObject<HTMLDivElement | null>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const stage = React.useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = React.useState<Point | null>(null);
  const drawing = useReviewDrawing(props, stage, viewport);
  const creator = useSoundEffectPageEditor({
    stageRef: stage,
    visualSize: {
      width: (props.crop.w * props.zoom) / 100,
      height: (props.crop.h * props.zoom) / 100,
    },
    onCreateRegion: props.form.addRegion,
    onUpdateRegion: (id, box) => props.form.update(id, { sourceBbox: box }),
  });
  const strokes = [
    ...props.form.strokes,
    ...(drawing.draft && props.tool !== "paint" ? [drawing.draft] : []),
  ];
  return (
    <div
      className={styles.viewport}
      ref={viewport}
      tabIndex={0}
      aria-label={t("regionOptions.preview")}
      onPointerDownCapture={focusReviewViewport}
    >
      <div className={styles.canvasSpace}>
        <div
          ref={stage}
          className={styles.stage}
          style={{
            width: (props.crop.w * props.zoom) / 100,
            height: (props.crop.h * props.zoom) / 100,
          }}
          data-tool={props.tool}
          data-region-review-stage=""
          {...drawing.handlers}
          onPointerDown={(event) => {
            if (props.tool === "add" && !props.disabled && event.button === 0) {
              event.preventDefault();
              creator.beginCreate(event);
            } else drawing.handlers.onPointerDown?.(event);
          }}
          onPointerMove={(event) => {
            setCursor(regionReviewPosition(event, stage));
            drawing.handlers.onPointerMove?.(event);
          }}
          onPointerLeave={() => setCursor(null)}
        >
          <ReviewSource props={props} />
          <ReviewExclusions props={props} strokes={strokes} />
          <ReviewBoxes props={props} stage={stage} />
          <PaintedSelection
            props={props}
            draft={props.tool === "paint" ? drawing.draft : null}
          />
          <DraftRegion bbox={creator.creationBbox} />
          <ReviewCursor props={props} cursor={cursor} />
        </div>
      </div>
    </div>
  );
}

function DraftRegion({ bbox }: { bbox: BBox | null }) {
  const { t } = useTranslation("components");
  return bbox ? (
    <RegionSelectionOverlay
      bbox={bbox}
      selected={false}
      disabled
      label={t("regionOptions.add")}
      targetProps={{}}
      resizeProps={() => ({})}
    />
  ) : null;
}

function PaintedSelection({
  props,
  draft,
}: {
  props: Props;
  draft: Form["strokes"][number] | null;
}) {
  const strokes = [
    ...(props.form.values.find((value) => value.regionId === props.form.focused)
      ?.selectionStrokes ?? []),
    ...(draft ? [draft] : []),
  ];
  if (!strokes.length) return null;
  return (
    <div
      className={styles.included}
      style={{
        maskImage: `url("data:image/svg+xml,${encodeURIComponent(paintedSelectionSvg(strokes))}")`,
      }}
    />
  );
}

function ReviewBoxes({
  props,
  stage,
}: {
  props: Props;
  stage: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <>
      {" "}
      {props.form.values.map((value, index) => (
        <ReviewBox
          key={value.regionId}
          props={props}
          stage={stage}
          value={value}
          index={index}
        />
      ))}
    </>
  );
}

function ReviewBox({
  props,
  stage,
  value,
  index,
}: {
  props: Props;
  stage: React.RefObject<HTMLDivElement | null>;
  value: Form["values"][number];
  index: number;
}) {
  const { t } = useTranslation("components");
  const handlers = useRegionReviewBoxGestures(props, stage, value.regionId);
  return (
    <RegionSelectionOverlay
      bbox={value.sourceBbox}
      selected={value.regionId === props.form.focused}
      disabled={props.disabled || props.tool !== "bounds"}
      label={t("regionOptions.translationNumber", { number: index + 1 })}
      targetProps={{
        "aria-pressed": value.regionId === props.form.focused,
        onFocus: () => props.form.setFocused(value.regionId),
        onClick: (event) => {
          if (event.detail === 0) props.form.setFocused(value.regionId);
        },
        ...handlers(value.sourceBbox),
      }}
      resizeProps={(direction) => handlers(value.sourceBbox, direction)}
    >
      <span className={styles.boxNumber}>{index + 1}</span>
    </RegionSelectionOverlay>
  );
}

function ReviewCursor({
  props,
  cursor,
}: {
  props: Props;
  cursor: Point | null;
}) {
  if (
    !cursor ||
    props.disabled ||
    (props.tool !== "hide" &&
      props.tool !== "restore" &&
      props.tool !== "paint")
  )
    return null;
  return (
    <CircularBrushCursor
      kind="retouch"
      color="var(--accent)"
      style={{
        visibility: "visible",
        opacity: 1,
        left: `${cursor.x / 10}%`,
        top: `${cursor.y / 10}%`,
        width: (props.size * props.zoom) / 100,
        height: (props.size * props.zoom) / 100,
        transform: "translate(-50%, -50%)",
        borderRadius: props.shape === "square" ? 0 : undefined,
      }}
    />
  );
}

function ReviewSource({ props }: { props: Props }) {
  const { t } = useTranslation("components");
  return (
    <svg
      viewBox={`${props.crop.x} ${props.crop.y} ${props.crop.w} ${props.crop.h}`}
      className={styles.image}
      role="img"
      aria-label={t("regionOptions.preview")}
    >
      {props.source ? (
        <image
          href={props.source}
          width={props.page.width}
          height={props.page.height}
          onError={() => props.setFailed(true)}
        />
      ) : null}
    </svg>
  );
}

function focusReviewViewport(event: React.PointerEvent<HTMLDivElement>) {
  if (!(event.target instanceof Element) || !event.target.closest("button"))
    event.currentTarget.focus({ preventScroll: true });
}

function ReviewExclusions({
  props,
  strokes,
}: {
  props: Props;
  strokes: Form["strokes"];
}) {
  const selectedBox = props.form.values.find(
    (value) => value.regionId === props.form.focused,
  )?.sourceBbox;
  const mask = letteringMaskSvg(strokes).replace(/white|black/g, (color) =>
    color === "white" ? "black" : "white",
  );
  return (
    <div
      className={styles.excluded}
      data-exclusion-region={props.form.focused}
      style={{
        clipPath: selectedBox
          ? `inset(${selectedBox.y / 10}% ${100 - (selectedBox.x + selectedBox.w) / 10}% ${100 - (selectedBox.y + selectedBox.h) / 10}% ${selectedBox.x / 10}%)`
          : "inset(100%)",
        maskImage: `url("data:image/svg+xml,${encodeURIComponent(mask)}")`,
      }}
    />
  );
}
