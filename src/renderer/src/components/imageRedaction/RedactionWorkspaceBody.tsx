import React from "react";
import type { ManualRedactionWorkspaceModel } from "./useManualRedactionWorkspace";
import { RedactionWorkspaceHeader } from "./RedactionWorkspaceHeader";
import { RedactionBatchActions } from "./RedactionBatchActions";
import { RedactionPageGrid } from "./RedactionPageGrid";
import { RedactionCanvas } from "./RedactionCanvas";
import { RedactionTools } from "./RedactionTools";
import styles from "./RedactionWorkspace.module.css";

type Props = { model: ManualRedactionWorkspaceModel };

export function RedactionWorkspaceBody({ model, preparation }: Props & { preparation: boolean }): React.JSX.Element {
  const { form, actions, ids, source, setDialog, setBatch } = model;
  const { view } = form.state.workspace;
  return (
    <>
      <RedactionWorkspaceHeader form={form} preparation={preparation} onOpen={actions.open} onHelp={() => setDialog("help")} />
      <RedactionBatchActions form={form} ids={ids}
        onReview={() => setBatch({ kind: "review", ids: [...view.selectedIds] })}
        onCopy={() => setBatch({ kind: "copy", ids: [...view.selectedIds], source })}
      />
      <RedactionEditPanel model={model} />
      <div className={styles.panel} id="redaction-panel-grid" role="tabpanel"
        aria-labelledby="redaction-tab-grid" hidden={view.mode !== "grid"}>
        {view.mode === "grid" ? <RedactionPageGrid form={form} ids={ids} onOpen={actions.open} /> : null}
      </div>
      {form.error ? <p role="alert" className={styles.inlineError}>{form.error}</p> : null}
    </>
  );
}

function RedactionEditPanel({ model }: Props): React.JSX.Element {
  const { form, selected, setSelected, actions, keyboard, ids, page, previousMask, onPageReady, setDialog } = model;
  const active = form.state.workspace.view.mode === "edit";
  return (
    <div className={styles.panel} id="redaction-panel-edit" role="tabpanel" aria-labelledby="redaction-tab-edit" hidden={!active}>
      {active ? <>
        <RedactionTools form={form} selected={selected} setSelected={setSelected}
          onPreviousMask={previousMask} onPresets={() => setDialog("presets")} />
        <div className={styles.layout}>
          <aside className={styles.sidebar}>
            <RedactionPageGrid compact form={form} ids={ids} onOpen={actions.open} />
          </aside>
          <RedactionCanvas key={page.id} form={form} page={page} selected={selected}
            setSelected={setSelected} spaceHeld={keyboard.spaceHeld} onReady={onPageReady} />
        </div>
      </> : null}
    </div>
  );
}
