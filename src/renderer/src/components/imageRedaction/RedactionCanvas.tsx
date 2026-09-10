import React from "react";
import { useTranslation } from "react-i18next";
import type { RedactionWorkspacePage } from "../../../../shared/imageRedactionWorkspace";
import { redactionStrokeBounds } from "../../../../shared/imageRedactionEditing";
import { useEventCallback } from "../../hooks/useEventCallback";
import { Button } from "../ui/Button";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";
import {
  changeRedactionStrokes,
  changeRedactionView,
} from "./redactionWorkspaceModel";
import { RedactionMaskCanvas } from "./RedactionMaskCanvas";
import { RedactionZoomControls } from "./RedactionTools";
import { useRedactionPreview } from "./useRedactionPreview";
import { useRedactionGestures } from "./useRedactionGestures";
import { useRedactionViewport } from "./useRedactionViewport";
import styles from "./RedactionWorkspace.module.css";

type Props = {
  form: RedactionWorkspaceController;
  page: RedactionWorkspacePage;
  selected: number;
  setSelected: (index: number) => void;
  spaceHeld: boolean;
  onReady: (ready: boolean) => void;
};
export function RedactionCanvas(props: Props): React.JSX.Element {
  const { t } = useTranslation("components");
  const { form, page, selected, setSelected, spaceHeld } = props;
  const { state, commit, markPreview } = form;
  const document = state.documents[page.id];
  const image = useRedactionPreview(
    form.previews,
    state.workspace.sessionId,
    page.id,
    2048,
  );
  const readiness = useCanvasReadiness(props, image.error, document.strokes);
  const view = useRedactionViewport(
    page,
    state.workspace.view.pageViews[page.id],
    (next) =>
      commit((current) =>
        changeRedactionView(current, {
          pageViews: { ...current.workspace.view.pageViews, [page.id]: next },
        }),
      ),
    form.busy || form.drawing,
  );
  const drawing = useRedactionGestures({
    page,
    strokes: document.strokes,
    preferences: state.workspace.preferences,
    viewport: view.viewport,
    disabled: form.busy || !image.url || readiness.failed,
    spaceHeld,
    selected,
    setSelected,
    onDrawing: form.setDrawing,
    onChange: (strokes) =>
      commit((current) => changeRedactionStrokes(current, page.id, strokes)),
  });
  const strokes = drawing.transformed ?? document.strokes;
  return (
    <div className={styles.editor}>
      <RedactionZoomControls form={form} pageId={page.id} zoom={view.zoom} />
      <div
        className={styles.viewport}
        ref={view.viewport}
        onScroll={view.onScroll}
      >
        <div
          ref={view.stage}
          className={styles.stage}
          tabIndex={0}
          role="group"
          aria-label={t("manualRedaction.canvas")}
          data-redaction-stage
          data-tool={spaceHeld ? "pan" : state.workspace.preferences.tool}
          style={{
            width: (page.width * view.zoom) / 100,
            height: (page.height * view.zoom) / 100,
          }}
          {...drawing.handlers}
        >
          {image.url ? (
            <img
              src={image.url}
              alt={page.name}
              draggable={false}
              className={styles.sourceImage}
              onLoad={readiness.decoded}
              onError={() => {
                readiness.reject();
                markPreview(page.id, "error");
              }}
            />
          ) : null}
          {image.url && !readiness.failed ? (
            <RedactionMaskCanvas
              width={page.width}
              height={page.height}
              strokes={strokes}
              draft={drawing.draft}
              onReady={readiness.masked}
              onFailure={readiness.reject}
            />
          ) : null}
          {strokes[selected] ? (
            <SelectionOutline
              page={page}
              selected={strokes[selected]}
              zoom={view.zoom}
            />
          ) : null}
        </div>
      </div>
      {image.error || readiness.failed ? (
        <div role="alert" className={styles.inlineError}>
          <span>{t("manualRedaction.previewFailed")}</span>
          <Button
            size="sm"
            onClick={() => {
              readiness.retry();
              image.retry();
            }}
          >
            {t("imageRedaction.retry")}
          </Button>
        </div>
      ) : !image.url ? (
        <p role="status">{t("manualRedaction.loading")}</p>
      ) : null}
      <p className={styles.hint}>{t("manualRedaction.canvasHint")}</p>
    </div>
  );
}

function useCanvasReadiness(
  props: Props,
  imageError: unknown,
  strokes: RedactionWorkspacePage["strokes"],
) {
  const [decoded, setDecoded] = React.useState(false);
  const [masked, setMasked] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const notify = useEventCallback(props.onReady);
  const { markPreview } = props.form;
  React.useLayoutEffect(() => {
    setMasked(false);
  }, [strokes]);
  React.useEffect(() => {
    notify(decoded && masked && !failed && !imageError);
    if (failed || imageError) markPreview(props.page.id, "error");
    else if (decoded && masked) markPreview(props.page.id, "ready");
    return () => notify(false);
  }, [decoded, masked, failed, imageError, notify, markPreview, props.page.id]);
  return {
    failed,
    decoded: () => setDecoded(true),
    masked: () => setMasked(true),
    reject: (error?: unknown) => {
      setFailed(true);
      if (error) props.form.report(error);
    },
    retry: () => {
      setFailed(false);
      setDecoded(false);
      setMasked(false);
    },
  };
}

function SelectionOutline({
  page,
  selected,
  zoom,
}: {
  page: RedactionWorkspacePage;
  selected: RedactionWorkspacePage["strokes"][number];
  zoom: number;
}) {
  const bounds = redactionStrokeBounds(selected);
  const handle = (10 * 100) / Math.max(1, zoom);
  return (
    <svg
      className={styles.selectionOverlay}
      viewBox={`0 0 ${page.width} ${page.height}`}
      aria-hidden="true"
    >
      <rect
        className={styles.selectionBounds}
        x={bounds.x}
        y={bounds.y}
        width={bounds.width}
        height={bounds.height}
        vectorEffect="non-scaling-stroke"
      />
      {selected.shape === "rectangle" ? (
        <rect
          className={styles.selectionHandle}
          x={bounds.x + bounds.width - handle / 2}
          y={bounds.y + bounds.height - handle / 2}
          width={handle}
          height={handle}
        />
      ) : null}
    </svg>
  );
}
