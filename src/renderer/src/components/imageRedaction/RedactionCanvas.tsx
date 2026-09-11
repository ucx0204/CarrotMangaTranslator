import React from "react";
import { useTranslation } from "react-i18next";
import type { RedactionWorkspacePage } from "../../../../shared/imageRedactionWorkspace";
import { redactionStrokeBounds } from "../../../../shared/imageRedactionEditing";
import { Button } from "../ui/Button";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";
import {
  changeRedactionStrokes,
  changeRedactionView,
} from "./redactionWorkspaceModel";
import { RedactionMaskCanvas } from "./RedactionMaskCanvas";
import { useRedactionCanvasImage } from "./useRedactionCanvasImage";
import { RedactionZoomControls } from "./RedactionTools";
import { useRedactionGestures } from "./useRedactionGestures";
import { useRedactionViewport } from "./useRedactionViewport";
import { useRedactionMaskWindow } from "./useRedactionMaskWindow";
import type { RedactionMaskWindow } from "./redactionMaskWindow";
import styles from "./RedactionWorkspace.module.css";

type Props = {
  form: RedactionWorkspaceController;
  page: RedactionWorkspacePage;
  selected: number;
  setSelected: (index: number) => void;
  spaceHeld: boolean;
  onReady: (ready: boolean) => void;
  toolbar: React.ReactNode;
};
export function RedactionCanvas(props: Props): React.JSX.Element {
  const { t } = useTranslation("components");
  const { form, page, selected, setSelected, spaceHeld } = props;
  const { state, commit } = form;
  const document = state.documents[page.id];
  const { viewportRef, stageRef, zoom, onScroll } = useCanvasViewport(props);
  const window = useRedactionMaskWindow(viewportRef, stageRef, page, zoom);
  const { image, readiness, inspection } = useRedactionCanvasImage({
    ...props,
    window,
    zoom,
  });
  const { handlers, draft, transformed } = useRedactionGestures({
    page,
    strokes: document.strokes,
    preferences: state.workspace.preferences,
    viewport: viewportRef,
    disabled: form.busy || !readiness.ready,
    spaceHeld,
    selected,
    setSelected,
    onDrawing: form.setDrawing,
    onChange: (strokes) =>
      commit((current) => changeRedactionStrokes(current, page.id, strokes)),
  });
  const strokes = transformed ?? document.strokes;
  return (
    <div className={styles.editor}>
      <div className={styles.editorToolbar}>
        {props.toolbar}
        <RedactionZoomControls form={form} pageId={page.id} zoom={zoom} />
      </div>
      <div className={styles.viewport} ref={viewportRef} onScroll={onScroll}>
        <div
          ref={stageRef}
          className={styles.stage}
          tabIndex={0}
          role="group"
          aria-label={t("manualRedaction.canvas")}
          data-redaction-stage
          data-tool={spaceHeld ? "pan" : state.workspace.preferences.tool}
          style={{
            width: (page.width * zoom) / 100,
            height: (page.height * zoom) / 100,
          }}
          {...handlers}
        >
          <CanvasImage
            key={image.key}
            page={page}
            image={image}
            readiness={readiness}
            strokes={strokes}
            draft={draft}
            window={window}
            inspection={inspection}
          />
          {strokes[selected] ? (
            <SelectionOutline
              page={page}
              selected={strokes[selected]}
              zoom={zoom}
            />
          ) : null}
        </div>
      </div>
      <PreviewNotice
        image={image}
        readiness={readiness}
        form={form}
        pageId={page.id}
      />
    </div>
  );
}
type ImageState = ReturnType<typeof useRedactionCanvasImage>["image"];
type Readiness = ReturnType<typeof useRedactionCanvasImage>["readiness"];
function CanvasImage({
  page,
  image,
  readiness,
  strokes,
  draft,
  window,
  inspection,
}: {
  inspection: React.ReactNode;
  page: RedactionWorkspacePage;
  window: RedactionMaskWindow;
  image: ImageState;
  readiness: Readiness;
  strokes: RedactionWorkspacePage["strokes"];
  draft: RedactionWorkspacePage["strokes"][number] | null;
}): React.JSX.Element | null {
  if (!image.url) return null;
  return (
    <>
      <img
        src={image.url}
        alt={page.name}
        draggable={false}
        className={styles.sourceImage}
        onLoad={readiness.decoded}
        onError={() => readiness.reject()}
      />
      {inspection}
      {!readiness.failed ? (
        <RedactionMaskCanvas
          width={page.width}
          height={page.height}
          strokes={strokes}
          draft={draft}
          window={window}
          onReady={readiness.masked}
          onFailure={readiness.reject}
        />
      ) : null}
    </>
  );
}
function PreviewNotice({
  image,
  readiness,
  form,
  pageId,
}: {
  image: ImageState;
  readiness: Readiness;
  form: Pick<
    RedactionWorkspaceController,
    "failed" | "busy" | "drawing" | "commit"
  >;
  pageId: string;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (form.failed.has(pageId) || image.error || readiness.failed)
    return (
      <div role="alert" className={styles.inlineError}>
        <span>{t("manualRedaction.previewFailed")}</span>
        <Button
          size="sm"
          disabled={form.busy || form.drawing}
          onClick={() => {
            // Reveal the thumbnail so its decode/mask failure is retried too.
            form.commit((current) =>
              changeRedactionView(current, { filter: "all" }),
            );
            image.retry();
          }}
        >
          {t("imageRedaction.retry")}
        </Button>
      </div>
    );
  return image.url ? null : <p role="status">{t("manualRedaction.loading")}</p>;
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

function useCanvasViewport({ form, page }: Props) {
  const { state, commit } = form;
  return useRedactionViewport(
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
}
