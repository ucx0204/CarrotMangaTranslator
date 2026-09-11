import React from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../ui/Modal";
import type { ManualRedactionWorkspaceProps } from "./manualRedactionWorkspaceTypes";
import { useManualRedactionWorkspace } from "./useManualRedactionWorkspace";
import { RedactionWorkspaceHeader } from "./RedactionWorkspaceHeader";
import { RedactionWorkspaceBody } from "./RedactionWorkspaceBody";
import { RedactionWorkspaceDialogs } from "./RedactionWorkspaceDialogs";
import { RedactionWorkspaceFooter } from "./RedactionWorkspaceFooter";
import styles from "./RedactionWorkspace.module.css";

export function ManualRedactionWorkspace(
  props: ManualRedactionWorkspaceProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const rootRef = React.useRef<HTMLDivElement>(null);
  const model = useManualRedactionWorkspace(props, rootRef);
  const { form, actions, keyboard, setDialog } = model;
  return (
    <>
      <Modal
        title={t("manualRedaction.title")}
        size="xl"
        width="min(1440px, 100%)"
        fillHeight
        bodyLayout="flex"
        onEntered={actions.focus}
        headerExtra={
          <RedactionWorkspaceHeader
            disabled={form.busy || form.drawing}
            hasPreviousMask={model.summary.hasPreviousMask}
            preparation={!props.job}
            onHelp={() => setDialog("help")}
            onPresets={() => setDialog("presets")}
            onPreviousMask={model.previousMask}
            onExit={() => setDialog("exit")}
          />
        }
        onClose={() => setDialog("exit")}
        closeDisabled={form.busy || form.drawing}
        footer={
          <RedactionWorkspaceFooter
            progress={model.summary}
            failedCount={form.failed.size}
            disabled={form.busy || form.drawing}
            saveStatus={form.saveStatus}
            onRetrySave={() => {
              void form.flush().catch(() => undefined);
            }}
            preparation={!props.job}
            onUnreviewed={actions.nextUnreviewed}
            onIssue={actions.showIssue}
            onContinue={actions.continueWork}
          />
        }
      >
        <div
          className={styles.workspace}
          ref={rootRef}
          data-redaction-workspace
          {...keyboard.handlers}
        >
          <RedactionWorkspaceBody model={model} />
        </div>
      </Modal>
      <RedactionWorkspaceDialogs model={model} />
    </>
  );
}
