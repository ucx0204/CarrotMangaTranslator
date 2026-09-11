import React from "react";
import { useTranslation } from "react-i18next";
import type { RedactionWorkspace } from "../../../shared/imageRedactionWorkspace";
import type { RedactionPreparationRequest } from "../lib/redactionPreparation";
import { analysisGateway } from "../api/analysisGateway";
import { useEventCallback } from "../hooks/useEventCallback";
import { useAsyncErrorState } from "../hooks/useAsyncErrorState";
import { ManualRedactionWorkspace } from "./imageRedaction/ManualRedactionWorkspace";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";

type Props = {
  request: RedactionPreparationRequest;
  beforeOpen: () => Promise<void>;
  onClose: () => void;
};

/** Preparation owns only a local draft. No job id or approval action is created. */
export function ImageRedactionPreparationHost(props: Props): React.JSX.Element {
  const { t } = useTranslation("components");
  const [attempt, setAttempt] = React.useState(0);
  const [workspace, setWorkspace] = React.useState<RedactionWorkspace | null>(
    null,
  );
  const { error, setError, report } = useAsyncErrorState(
    t("manualRedaction.operationFailed"),
  );
  const beforeOpen = useEventCallback(props.beforeOpen);
  React.useEffect(() => {
    let disposed = false;
    let session: string | undefined;
    setError("");
    const open = async () => {
      await beforeOpen();
      if (disposed) return;
      const loaded = await analysisGateway.openRedactionWorkspace(props.request);
      session = loaded.sessionId;
      if (disposed) await analysisGateway.closeRedactionWorkspace(session);
      else setWorkspace(loaded);
    };
    void open().catch((failure: unknown) => {
      if (!disposed) report(failure);
      else
        console.error(
          "Redaction preparation stopped while opening",
          failure,
        );
    });
    return () => {
      disposed = true;
      if (session)
        void analysisGateway
          .closeRedactionWorkspace(session)
          .catch((failure: unknown) =>
            console.error("Redaction preparation cleanup failed", failure),
          );
    };
  }, [props.request, beforeOpen, attempt, setError, report]);
  if (workspace)
    return (
      <ManualRedactionWorkspace
        workspace={workspace}
        onClose={props.onClose}
      />
    );
  return (
    <Modal
      title={t("manualRedaction.prepareEditor")}
      size="sm"
      onClose={props.onClose}
      footer={
        <>
          {error ? (
            <Button onClick={() => setAttempt((value) => value + 1)}>
              {t("imageRedaction.retry")}
            </Button>
          ) : null}
          <Button onClick={props.onClose}>{t("common.cancel")}</Button>
        </>
      }
    >
      <p role={error ? "alert" : "status"}>
        {error || t("manualRedaction.loading")}
      </p>
    </Modal>
  );
}
