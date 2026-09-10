import React from "react";
import type { ManualRedactionWorkspaceModel } from "./useManualRedactionWorkspace";
import { RedactionBatchDialog } from "./RedactionBatchDialog";
import { RedactionPresetsDialog } from "./RedactionPresetsDialog";
import { RedactionShortcutDialog } from "./RedactionShortcutDialog";
import { RedactionExitDialog } from "./RedactionExitDialog";

export function RedactionWorkspaceDialogs({
  model,
}: {
  model: ManualRedactionWorkspaceModel;
}): React.JSX.Element {
  const { form, batch, dialog, setBatch, setDialog, source, page, actions } =
    model;
  const { selectedIds } = form.state.workspace.view;
  return (
    <>
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
              ids: selectedIds.length ? [...selectedIds] : [page.id],
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
          error={form.error}
          onClose={() => setDialog(null)}
          onSave={actions.saveExit}
          onDiscard={actions.discard}
        />
      ) : null}
    </>
  );
}
