import React from "react";
import { useEventCallback } from "../../hooks/useEventCallback";
import type { ManualRedactionWorkspaceProps, RedactionBatchIntent } from "./manualRedactionWorkspaceTypes";
import { useRedactionWorkspace } from "./useRedactionWorkspace";
import { useRedactionWorkspaceActions } from "./useRedactionWorkspaceActions";
import { useRedactionKeyboard } from "./useRedactionKeyboard";
import { filteredRedactionPages } from "./redactionWorkspaceModel";

export type ManualRedactionWorkspaceModel = ReturnType<typeof useManualRedactionWorkspace>;

export function useManualRedactionWorkspace(
  props: ManualRedactionWorkspaceProps,
  root: React.RefObject<HTMLDivElement | null>,
) {
  const form = useRedactionWorkspace(props.workspace);
  const [selected, setSelected] = React.useState(-1);
  const [dialog, setDialog] = React.useState<"help" | "presets" | "exit" | null>(null);
  const [batch, setBatch] = React.useState<RedactionBatchIntent | null>(null);
  const [detail, setDetail] = React.useState({ id: "", ready: false });
  const { state } = form;
  const { view, pages } = state.workspace;
  const page = pages.find((item) => item.id === view.currentId) ?? pages[0];
  const detailReady = detail.id === page.id && detail.ready && view.mode === "edit";
  const actions = useRedactionWorkspaceActions({
    form, root, job: props.job, onClose: props.onClose, setSelected, detailReady,
  });
  const keyboard = useRedactionKeyboard({
    form, selected, setSelected, dialogOpen: Boolean(dialog || batch),
    onPrevious: actions.previous, onNext: actions.next,
    onConfirm: actions.confirm, onDefer: actions.defer, onContinue: actions.continueWork,
  });
  const ids = React.useMemo(() => filteredRedactionPages(state, form.failed), [state, form.failed]);
  const strokes = state.documents[page.id].strokes;
  const source = {
    width: page.width, height: page.height,
    strokes: selected >= 0 && strokes[selected] ? [strokes[selected]] : strokes,
  };
  const previousMask = () => {
    const previous = pages[pages.findIndex((item) => item.id === page.id) - 1];
    if (previous) setBatch({
      kind: "copy", ids: [page.id],
      source: { width: previous.width, height: previous.height, strokes: state.documents[previous.id].strokes },
    });
  };
  const onPageReady = useEventCallback((ready: boolean) => {
    setDetail((current) => current.id === page.id && current.ready === ready ? current : { id: page.id, ready });
  });
  useNeighborPreviews(form);
  return { form, selected, setSelected, dialog, setDialog, batch, setBatch, page,
    detailReady, actions, keyboard, ids, source, previousMask, onPageReady };
}

function useNeighborPreviews(form: ReturnType<typeof useRedactionWorkspace>): void {
  const { previews, markPreview } = form;
  const { pages, sessionId, view } = form.state.workspace;
  React.useEffect(() => {
    if (view.mode !== "edit") return;
    let active = true;
    const index = pages.findIndex((page) => page.id === view.currentId);
    for (const page of pages.slice(index + 1, index + 3)) {
      void previews.read({ sessionId, pageId: page.id, maxEdge: 2048 }).catch((_error: unknown) => {
        if (active) markPreview(page.id, "error");
      });
    }
    return () => { active = false; };
  }, [previews, markPreview, pages, sessionId, view.currentId, view.mode]);
}
