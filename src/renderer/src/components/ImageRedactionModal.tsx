import React from "react";
import { useTranslation } from "react-i18next";
import type { ImageRedactionReview } from "../../../shared/imageRedaction";
import type { RedactionWorkspace } from "../../../shared/imageRedactionWorkspace";
import { analysisGateway } from "../api/analysisGateway";
import { formatErrorMessage } from "../lib/errorPresentation";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { ManualRedactionWorkspace } from "./imageRedaction/ManualRedactionWorkspace";

export function ImageRedactionModal({
  review,
  onClose,
}: {
  review: ImageRedactionReview & { jobId: string };
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const { workspace, error, setError, setAttempt } = useReviewWorkspace(review);
  const [busy, setBusy] = React.useState(false);
  const cancel = async () => {
    setBusy(true);
    try {
      await analysisGateway.cancelJob({ jobId: review.jobId });
      onClose();
    } catch (failure) {
      setError(
        formatErrorMessage(failure, t("manualRedaction.operationFailed")),
      );
    } finally {
      setBusy(false);
    }
  };
  if (workspace)
    return (
      <ManualRedactionWorkspace
        key={workspace.sessionId}
        workspace={workspace}
        job={{ jobId: review.jobId, sessionId: review.sessionId }}
        onClose={onClose}
      />
    );
  return (
    <Modal
      title={t("manualRedaction.title")}
      size="md"
      onClose={() => {
        void cancel();
      }}
      closeDisabled={busy}
    >
      <p role={error ? "alert" : "status"}>
        {error || t("manualRedaction.loading")}
      </p>
      {error ? (
        <Button
          disabled={busy}
          onClick={() => setAttempt((value) => value + 1)}
        >
          {t("imageRedaction.retry")}
        </Button>
      ) : null}
      <Button
        disabled={busy}
        onClick={() => {
          void cancel();
        }}
      >
        {t("common.cancel")}
      </Button>
    </Modal>
  );
}

function useReviewWorkspace(review: ImageRedactionReview & { jobId: string }) {
  const { t } = useTranslation("components");
  const [workspace, setWorkspace] = React.useState<RedactionWorkspace | null>(
    null,
  );
  const [error, setError] = React.useState("");
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    void analysisGateway
      .openRedactionWorkspace({
        kind: "job",
        jobId: review.jobId,
        sessionId: review.sessionId,
      })
      .then(
        (value) => {
          if (active) {
            setWorkspace(value);
            setError("");
          }
        },
        (failure: unknown) => {
          if (active)
            setError(
              formatErrorMessage(failure, t("manualRedaction.openFailed")),
            );
        },
      );
    return () => {
      active = false;
    };
  }, [review.jobId, review.sessionId, attempt, t]);
  return { workspace, error, setError, setAttempt };
}
