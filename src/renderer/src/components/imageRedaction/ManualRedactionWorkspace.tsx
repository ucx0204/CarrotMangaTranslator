import React from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../ui/Modal";
import type { ManualRedactionWorkspaceProps } from "./manualRedactionWorkspaceTypes";
import { useManualRedactionWorkspace } from "./useManualRedactionWorkspace";
import { RedactionWorkspaceBody } from "./RedactionWorkspaceBody";
import { RedactionWorkspaceDialogs } from "./RedactionWorkspaceDialogs";
import { RedactionWorkspaceFooter } from "./RedactionWorkspaceFooter";
import styles from "./RedactionWorkspace.module.css";

export function ManualRedactionWorkspace(props: ManualRedactionWorkspaceProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const rootRef = React.useRef<HTMLDivElement>(null);
  const model = useManualRedactionWorkspace(props, rootRef);
  const { form, actions, keyboard, setDialog, detailReady } = model;
  return (
    <>
      <Modal
        title={t("manualRedaction.title")} size="xl" width="1440px"
        fillHeight bodyLayout="flex" onEntered={actions.focus}
        onClose={() => setDialog("exit")} closeDisabled={form.busy || form.drawing}
        footer={<RedactionWorkspaceFooter
          form={form} preparation={!props.job} detailReady={detailReady}
          onPrevious={actions.previous} onNext={actions.next}
          onConfirm={actions.confirm} onDefer={actions.defer}
          onContinue={actions.continueWork} onExit={() => setDialog("exit")}
        />}
      >
        <div className={styles.workspace} ref={rootRef} data-redaction-workspace {...keyboard.handlers}>
          <RedactionWorkspaceBody model={model} preparation={!props.job} />
        </div>
      </Modal>
      <RedactionWorkspaceDialogs model={model} />
    </>
  );
}
