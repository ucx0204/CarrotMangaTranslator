import React from "react";
import type { ManualRedactionWorkspaceModel } from "./useManualRedactionWorkspace";
import { RedactionBatchActions } from "./RedactionBatchActions";
import { RedactionPageFilter } from "./RedactionPageFilter";
import { RedactionPageGrid } from "./RedactionPageGrid";
import { RedactionPageReviewBar } from "./RedactionPageReviewBar";
import { RedactionCanvas } from "./RedactionCanvas";
import { RedactionTools } from "./RedactionTools";
import styles from "./RedactionWorkspace.module.css";

export function RedactionWorkspaceBody({
  model,
}: {
  model: ManualRedactionWorkspaceModel;
}): React.JSX.Element {
  const {
    form,
    actions,
    ids,
    source,
    setBatch,
    page,
    selected,
    setSelected,
    keyboard,
    onPageReady,
  } = model;
  const { view } = form.state.workspace;
  return (
    <>
      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <RedactionPageFilter form={form} />
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
          <RedactionPageGrid form={form} ids={ids} onOpen={actions.open} />
        </aside>
        <div className={styles.editorPane}>
          <RedactionCanvas
            key={page.id}
            form={form}
            page={page}
            selected={selected}
            setSelected={setSelected}
            spaceHeld={keyboard.spaceHeld}
            onReady={onPageReady}
            toolbar={
              <RedactionTools
                form={form}
                selected={selected}
                setSelected={setSelected}
              />
            }
          />
          <RedactionPageReviewBar
            form={form}
            detailReady={model.detailReady}
            onPrevious={actions.previous}
            onNext={actions.next}
            onReview={actions.review}
            onOpen={actions.open}
          />
        </div>
      </div>
      {form.error ? (
        <p role="alert" className={styles.inlineError}>
          {form.error}
        </p>
      ) : null}
    </>
  );
}
