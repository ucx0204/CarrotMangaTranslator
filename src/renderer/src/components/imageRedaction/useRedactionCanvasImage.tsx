import React from "react";
import type { RedactionWorkspacePage } from "../../../../shared/imageRedactionWorkspace";
import type { RedactionWorkspaceController } from "./redactionWorkspaceTypes";
import type { RedactionMaskWindow } from "./redactionMaskWindow";
import { RedactionNativePreview } from "./RedactionNativePreview";
import { nativeRedactionPreviewKey } from "./redactionNativePreview";
import { useRedactionPreview } from "./useRedactionPreview";
import { useRedactionImageReadiness } from "./useRedactionImageReadiness";

/** Compose the overview, native inspection and exact-mask readiness in one place. */
export function useRedactionCanvasImage({
  form,
  page,
  onReady,
  window: renderKey,
  zoom,
}: {
  form: Pick<
    RedactionWorkspaceController,
    "state" | "previews" | "markPreview"
  >;
  page: RedactionWorkspacePage;
  onReady: (ready: boolean) => void;
  window: RedactionMaskWindow;
  zoom: number;
}) {
  const image = useRedactionPreview(
    form.previews,
    form.state.workspace.sessionId,
    page.id,
    2048,
  );
  const inspectionKey = nativeRedactionPreviewKey(
    form.previews,
    form.state.workspace.sessionId,
    page,
    renderKey,
    zoom,
  );
  // A new mount must decode again, including leaving and re-entering native zoom.
  const token = React.useMemo(() => ({ key: inspectionKey }), [inspectionKey]);
  const [inspected, setInspected] = React.useState<typeof token | null>(null);
  const readiness = useRedactionImageReadiness({
    inspectionReady: !inspectionKey || inspected === token,
    source: "detail",
    renderKey,
    form,
    pageId: page.id,
    ...image,
    requestKey: image.key,
    strokes: form.state.documents[page.id].strokes,
    onReady,
  });
  const inspection = inspectionKey ? (
    <RedactionNativePreview
      key={inspectionKey}
      cache={form.previews}
      sessionId={form.state.workspace.sessionId}
      page={page}
      window={renderKey}
      onReady={() => setInspected(token)}
      onFailure={readiness.reject}
    />
  ) : null;
  return { image, readiness, inspection };
}
