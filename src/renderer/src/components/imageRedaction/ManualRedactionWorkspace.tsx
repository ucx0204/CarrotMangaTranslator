import React from "react";
import { useTranslation } from "react-i18next";
import type { RedactionWorkspace } from "../../../../shared/imageRedactionWorkspace";
import { Modal } from "../ui/Modal";
import { useRedactionWorkspace } from "./useRedactionWorkspace";
import { useRedactionWorkspaceActions } from "./useRedactionWorkspaceActions";
import { useRedactionKeyboard } from "./useRedactionKeyboard";
import { filteredRedactionPages } from "./redactionWorkspaceModel";
import { RedactionWorkspaceHeader } from "./RedactionWorkspaceHeader";
import { RedactionWorkspaceFooter } from "./RedactionWorkspaceFooter";
import { RedactionBatchActions } from "./RedactionBatchActions";
import { RedactionPageGrid } from "./RedactionPageGrid";
import { RedactionCanvas } from "./RedactionCanvas";
import { RedactionTools } from "./RedactionTools";
import {
  RedactionBatchDialog,
  type RedactionBatchIntent,
} from "./RedactionBatchDialog";
import { RedactionPresetsDialog } from "./RedactionPresetsDialog";
import { RedactionShortcutDialog } from "./RedactionShortcutDialog";
import { RedactionExitDialog } from "./RedactionExitDialog";
import styles from "./RedactionWorkspace.module.css";

type Props = {
  workspace: RedactionWorkspace;
  job?: { jobId: string; sessionId: string };
  onClose: () => void;
};
export function ManualRedactionWorkspace({
  workspace,
  job,
  onClose,
}: Props): React.JSX.Element {
  const { t } = useTranslation("components");
  const form = useRedactionWorkspace(workspace);
  const root = React.useRef<HTMLDivElement>(null);
  const [selected, setSelected] = React.useState(-1);
  const [dialog, setDialog] = React.useState<
    "help" | "presets" | "exit" | null
  >(null);
  const [batch, setBatch] = React.useState<RedactionBatchIntent | null>(null);
  const [detail, setDetail] = React.useState({ id: "", ready: false });
  const { state } = form;
  const { view, pages } = state.workspace;
  const page = pages.find((item) => item.id === view.currentId) ?? pages[0];
  const detailReady =
    detail.id === page.id && detail.ready && view.mode === "edit";
  const actions = useRedactionWorkspaceActions({
    form,
    root,
    job,
    onClose,
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
    onDefer: actions.defer,
    onContinue: actions.continueWork,
  });
  const ids = React.useMemo(
    () => filteredRedactionPages(state, form.failed),
    [
      state.documents,
      state.workspace.view.filter,
      state.workspace.pages,
      form.failed,
    ],
  );
  const source = {
    width: page.width,
    height: page.height,
    strokes:
      selected >= 0 && state.documents[page.id].strokes[selected]
        ? [state.documents[page.id].strokes[selected]]
        : state.documents[page.id].strokes,
  };
  const previousMask = () => {
    const previous = pages[pages.findIndex((item) => item.id === page.id) - 1];
    if (previous)
      setBatch({
        kind: "copy",
        ids: [page.id],
        source: {
          width: previous.width,
          height: previous.height,
          strokes: state.documents[previous.id].strokes,
        },
      });
  };
  useNeighborPreviews(form);
  return (
    <>
      <Modal
        title={t("manualRedaction.title")}
        size="xl"
        width="1440px"
        fillHeight
        bodyLayout="flex"
        onEntered={actions.focus}
        onClose={() => setDialog("exit")}
        closeDisabled={form.busy || form.drawing}
        footer={
          <RedactionWorkspaceFooter
            form={form}
            preparation={!job}
            detailReady={detailReady}
            onPrevious={actions.previous}
            onNext={actions.next}
            onConfirm={actions.confirm}
            onDefer={actions.defer}
            onContinue={actions.continueWork}
            onExit={() => setDialog("exit")}
          />
        }
      >
        <div
          className={styles.workspace}
          ref={root}
          data-redaction-workspace
          {...keyboard.handlers}
        >
          <RedactionWorkspaceHeader
            form={form}
            onOpen={actions.open}
            onHelp={() => setDialog("help")}
          />
          <p className={styles.hint}>
            {t(
              job
                ? "manualRedaction.outboundHint"
                : "manualRedaction.preparationHint",
            )}
          </p>
          <RedactionBatchActions
            form={form}
            ids={ids}
            onReview={() =>
              setBatch({ kind: "review", ids: [...view.selectedIds] })
            }
            onCopy={() =>
              setBatch({ kind: "copy", ids: [...view.selectedIds], source })
            }
          />
          <div
            className={styles.panel}
            id="redaction-panel-edit"
            role="tabpanel"
            aria-labelledby="redaction-tab-edit"
            hidden={view.mode !== "edit"}
          >
            {view.mode === "edit" ? (
              <>
                <RedactionTools
                  form={form}
                  selected={selected}
                  setSelected={setSelected}
                  onPreviousMask={previousMask}
                  onPresets={() => setDialog("presets")}
                />
                <div className={styles.layout}>
                  <aside className={styles.sidebar}>
                    <RedactionPageGrid
                      compact
                      form={form}
                      ids={ids}
                      onOpen={actions.open}
                    />
                  </aside>
                  <RedactionCanvas
                    key={page.id}
                    form={form}
                    page={page}
                    selected={selected}
                    setSelected={setSelected}
                    spaceHeld={keyboard.spaceHeld}
                    onReady={(ready) =>
                      setDetail((current) =>
                        current.id === page.id && current.ready === ready
                          ? current
                          : { id: page.id, ready },
                      )
                    }
                  />
                </div>
              </>
            ) : null}
          </div>
          <div
            className={styles.panel}
            id="redaction-panel-grid"
            role="tabpanel"
            aria-labelledby="redaction-tab-grid"
            hidden={view.mode !== "grid"}
          >
            {view.mode === "grid" ? (
              <RedactionPageGrid form={form} ids={ids} onOpen={actions.open} />
            ) : null}
          </div>
          {form.error ? (
            <p role="alert" className={styles.inlineError}>
              {form.error}
            </p>
          ) : null}
        </div>
      </Modal>
      {batch ? (
        <RedactionBatchDialog
          form={form}
          intent={batch}
          onClose={() => setBatch(null)}
        />
      ) : null}
      {dialog === "presets" ? (
        <RedactionPresetsDialog
          form={form}
          source={source}
          onClose={() => setDialog(null)}
          onApply={(preset) => {
            setDialog(null);
            setBatch({
              kind: "copy",
              ids: view.selectedIds.length ? [...view.selectedIds] : [page.id],
              source: preset,
            });
          }}
        />
      ) : null}
      {dialog === "help" ? (
        <RedactionShortcutDialog form={form} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "exit" ? (
        <RedactionExitDialog
          busy={form.busy}
          onClose={() => setDialog(null)}
          onSave={actions.saveExit}
          onDiscard={actions.discard}
        />
      ) : null}
    </>
  );
}

function useNeighborPreviews(
  form: ReturnType<typeof useRedactionWorkspace>,
): void {
  const { previews, markPreview } = form;
  const { pages, sessionId, view } = form.state.workspace;
  React.useEffect(() => {
    if (view.mode !== "edit") return;
    let active = true;
    const index = pages.findIndex((page) => page.id === view.currentId);
    for (const page of pages.slice(index + 1, index + 3))
      void previews
        .read({ sessionId, pageId: page.id, maxEdge: 2048 })
        .catch(() => {
          if (active) markPreview(page.id, "error");
        });
    return () => {
      active = false;
    };
  }, [previews, markPreview, pages, sessionId, view.currentId, view.mode]);
}
