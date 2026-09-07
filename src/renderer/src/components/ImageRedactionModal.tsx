import React from "react";
import { useTranslation } from "react-i18next";
import {
  type ImageRedactionPage,
  type ImageRedactionReview,
} from "../../../shared/imageRedaction";
import { analysisGateway } from "../api/analysisGateway";
import { ImageRedactionEditor } from "./ImageRedactionEditor";
import { Modal } from "./ui/Modal";
import { ModalActionBar } from "./ui/ModalActionBar";
import { Button } from "./ui/Button";
import { Select } from "./ui/Select";
import styles from "./ImageRedactionModal.module.css";

export function ImageRedactionModal({
  review,
  onClose,
}: {
  review: ImageRedactionReview & { jobId: string };
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const [pages, setPages] = React.useState(review.pages);
  const [selected, setSelected] = React.useState(pages[0]?.id ?? "");
  const [loaded, setLoaded] = React.useState<Set<string>>(() => new Set());
  const markLoaded = React.useCallback(
    (id: string) => setLoaded((current) => new Set([...current, id])),
    [],
  );
  const { busy, error, execute } = useRedactionConfirmation(
    review,
    pages,
    onClose,
  );
  const page = pages.find((item) => item.id === selected);
  return (
    <Modal
      title={t("imageRedaction.title")}
      size="xl"
      fillHeight
      bodyLayout="flex"
      onClose={() => void execute(true)}
      closeDisabled={busy}
      footer={
        <RedactionActions
          busy={busy}
          ready={loaded.size === pages.length}
          execute={execute}
        />
      }
    >
      <Select
        ariaLabel={t("imageRedaction.pages")}
        value={selected}
        onValueChange={setSelected}
        disabled={busy}
        options={pages.map((item, index) => ({
          value: item.id,
          label: `${loaded.has(item.id) ? "✓ " : ""}${index + 1} · ${item.name}`,
        }))}
      />
      {page ? (
        <ImageRedactionEditor
          key={page.id}
          page={page}
          onLoaded={markLoaded}
          disabled={busy}
          onChange={(strokes) =>
            setPages((current) =>
              current.map((item) =>
                item.id === page.id ? { ...item, strokes } : item,
              ),
            )
          }
        />
      ) : null}
      <span>
        {t("imageRedaction.checked", {
          count: loaded.size,
          total: pages.length,
        })}
      </span>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

function useRedactionConfirmation(
  review: ImageRedactionReview & { jobId: string },
  pages: ImageRedactionPage[],
  onClose: () => void,
) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const execute = async (cancel: boolean) => {
    setBusy(true);
    setError("");
    try {
      if (cancel) await analysisGateway.cancelJob({ jobId: review.jobId });
      else
        await analysisGateway.confirmImageRedaction({
          ...review,
          pages: pages.map(({ id, fingerprint, strokes }) => ({
            id,
            fingerprint,
            strokes,
          })),
        });
      onClose();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, execute };
}

function RedactionActions({
  busy,
  ready,
  execute,
}: {
  busy: boolean;
  ready: boolean;
  execute: (cancel: boolean) => Promise<void>;
}) {
  const { t } = useTranslation("components");
  return (
    <ModalActionBar
      actions={
        <>
          <Button disabled={busy} onClick={() => void execute(true)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !ready}
            onClick={() => void execute(false)}
          >
            {t("imageRedaction.confirm")}
          </Button>
        </>
      }
    />
  );
}
