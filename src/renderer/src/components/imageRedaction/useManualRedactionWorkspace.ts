import React from "react";
import { useEventCallback } from "../../hooks/useEventCallback";
import type {
  ManualRedactionWorkspaceProps,
  RedactionBatchIntent,
} from "./manualRedactionWorkspaceTypes";
import { useRedactionWorkspace } from "./useRedactionWorkspace";
import { useRedactionWorkspaceActions } from "./useRedactionWorkspaceActions";
import { useRedactionKeyboard } from "./useRedactionKeyboard";
import { filteredRedactionPages } from "./redactionWorkspaceModel";

export type ManualRedactionWorkspaceModel = ReturnType<
  typeof useManualRedactionWorkspace
>;

export function useManualRedactionWorkspace(
  props: ManualRedactionWorkspaceProps,
  root: React.RefObject<HTMLDivElement | null>,
) {
  const form = useRedactionWorkspace(props.workspace);
  const [selected, setSelected] = React.useState(-1);
  const [dialog, setDialog] = React.useState<
    "help" | "presets" | "exit" | null
  >(null);
  const [batch, setBatch] = React.useState<RedactionBatchIntent | null>(null);
  const [detail, setDetail] = React.useState({ id: "", ready: false });
  const { state } = form;
  const { view, pages } = state.workspace;
  const page = pages.find((item) => item.id === view.currentId) ?? pages[0];
  const detailReady = detail.id === page.id && detail.ready;
  const actions = useRedactionWorkspaceActions({
    form,
    root,
    job: props.job,
    onClose: props.onClose,
    setSelected,
    detailReady,
  });
  const keyboard = useRedactionKeyboard({
    form,
    selected,
    setSelected,
    dialogOpen: Boolean(dialog || batch),
    onPrevious: actions.previous,
    onNext: actions.next,
    onConfirm: actions.confirm,
    onContinue: actions.continueWork,
  });
  const ids = React.useMemo(
    () =>
      filteredRedactionPages(pages, state.documents, view.filter, form.failed),
    [pages, state.documents, view.filter, form.failed],
  );
  const strokes = state.documents[page.id].strokes;
  const source = {
    width: page.width,
    height: page.height,
    strokes: selected >= 0 && strokes[selected] ? [strokes[selected]] : strokes,
  };
  const previousMask = () => openPreviousMask(form, page.id, setBatch);
  const onPageReady = useEventCallback((ready: boolean) => {
    setDetail((current) =>
      current.id === page.id && current.ready === ready
        ? current
        : { id: page.id, ready },
    );
  });
  useNeighborPreviews(form);
  return {
    form,
    selected,
    setSelected,
    dialog,
    setDialog,
    batch,
    setBatch,
    page,
    detailReady,
    actions,
    keyboard,
    ids,
    source,
    previousMask,
    onPageReady,
  };
}

function useNeighborPreviews(
  form: ReturnType<typeof useRedactionWorkspace>,
): void {
  const { previews, markPreview } = form;
  const { pages, sessionId, view } = form.state.workspace;
  React.useEffect(() => {
    let active = true;
    const index = pages.findIndex((page) => page.id === view.currentId);
    for (const page of pages.slice(index + 1, index + 3)) {
      const version = previews.version(sessionId, page.id);
      void previews
        .read({ sessionId, pageId: page.id, maxEdge: 2048 })
        .catch((_error: unknown) => {
          if (active && version === previews.version(sessionId, page.id))
            markPreview(page.id, "error");
        });
    }
    return () => {
      active = false;
    };
  }, [previews, markPreview, pages, sessionId, view.currentId]);
}

function openPreviousMask(
  form: ReturnType<typeof useRedactionWorkspace>,
  pageId: string,
  setBatch: (intent: RedactionBatchIntent) => void,
): void {
  const { state } = form;
  const { pages } = state.workspace;
  const previous = pages[pages.findIndex((item) => item.id === pageId) - 1];
  if (previous)
    setBatch({
      kind: "copy",
      ids: [pageId],
      source: {
        width: previous.width,
        height: previous.height,
        strokes: state.documents[previous.id].strokes,
      },
    });
}
