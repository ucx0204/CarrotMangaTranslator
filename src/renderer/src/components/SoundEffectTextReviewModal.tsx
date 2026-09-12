import React from "react";
import { useTranslation } from "react-i18next";
import type {
  SoundEffectTextReview,
  ConfirmSoundEffectTextReview,
} from "../../../shared/soundEffectTextReview";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { SelectionSurface } from "./ui/SelectionCard";
import { SoundEffectTextReviewPage } from "./SoundEffectTextReviewPage";
import type { useRegionReviewForm } from "./useRegionReviewForm";
import styles from "./SoundEffectTextReviewModal.module.css";

type Form = ReturnType<typeof useRegionReviewForm>;
type Props = {
  review: SoundEffectTextReview;
  busy?: boolean;
  error?: string;
  onConfirm: (
    pages: ConfirmSoundEffectTextReview["pages"],
  ) => void | Promise<void>;
  onClose: () => void;
};

export function SoundEffectTextReviewModal(props: Props) {
  const { t } = useTranslation("components");
  const state = useBatchReviewForms(props);
  const disabled = props.busy || state.preparing;
  return (
    <Modal
      title={t("soundEffectTextReview.title")}
      width="96vw"
      maxHeight="94vh"
      fillHeight
      bodyLayout="flex"
      onClose={props.onClose}
      closeDisabled={disabled}
      footer={
        <BatchReviewActions props={props} state={state} disabled={disabled} />
      }
    >
      <p className={styles.hint}>{t("soundEffectTextReview.hint")}</p>
      {props.error || state.error ? (
        <p role="alert">{props.error || state.error}</p>
      ) : null}
      <div className={styles.content}>
        <nav
          className={styles.pages}
          aria-label={t("soundEffectTextReview.pages")}
        >
          {props.review.pages.map((page, index) => (
            <SelectionSurface
              key={page.pageId}
              as="button"
              variant="row"
              className={styles.pageButton}
              selected={state.active === page.pageId}
              aria-current={state.active === page.pageId ? "page" : undefined}
              disabled={disabled}
              onClick={() => state.setActive(page.pageId)}
            >
              <strong>
                {index + 1} · {page.name}
              </strong>
              <span>
                {t("soundEffectTextReview.count", {
                  count:
                    state.status[page.pageId]?.count ??
                    page.review.regions.length,
                })}
              </span>
            </SelectionSurface>
          ))}
        </nav>
        {props.review.pages.map((page) => (
          <SoundEffectTextReviewPage
            key={page.pageId}
            page={page}
            active={state.active === page.pageId}
            busy={disabled}
            register={state.register}
          />
        ))}
      </div>
    </Modal>
  );
}

function BatchReviewActions({
  props,
  state,
  disabled,
}: {
  props: Props;
  state: ReturnType<typeof useBatchReviewForms>;
  disabled?: boolean;
}) {
  const { t } = useTranslation("components");
  return (
    <div className={styles.actions}>
      <span className={styles.summary}>
        {t("soundEffectTextReview.summary", {
          pages: props.review.pages.length,
          count: state.count,
        })}
      </span>
      <Button onClick={props.onClose} disabled={disabled}>
        {t("common.cancel")}
      </Button>
      <Button
        variant="primary"
        disabled={disabled || !state.valid}
        onClick={() => void state.confirm()}
      >
        {t("soundEffectTextReview.generate")}
      </Button>
    </div>
  );
}

function useBatchReviewForms(props: Props) {
  const [active, setActive] = React.useState(props.review.pages[0].pageId);
  const forms = React.useRef(new Map<string, Form>());
  const [status, setStatus] = React.useState<
    Record<string, { valid: boolean; count: number }>
  >({});
  const [preparing, setPreparing] = React.useState(false);
  const submitting = React.useRef(false);
  const [error, setError] = React.useState("");
  const register = React.useCallback((pageId: string, form: Form) => {
    forms.current.set(pageId, form);
    setStatus((previous) =>
      previous[pageId]?.valid === form.valid &&
      previous[pageId]?.count === form.values.length
        ? previous
        : {
            ...previous,
            [pageId]: { valid: form.valid, count: form.values.length },
          },
    );
  }, []);
  const confirm = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setPreparing(true);
    setError("");
    try {
      const pages: ConfirmSoundEffectTextReview["pages"] = [];
      for (const page of props.review.pages) {
        const form = forms.current.get(page.pageId);
        const value = form?.valid ? await form.confirm() : undefined;
        if (!value) {
          setActive(page.pageId);
          return;
        }
        pages.push({ pageId: page.pageId, ...value });
      }
      await props.onConfirm(pages);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      submitting.current = false;
      setPreparing(false);
    }
  };
  return {
    active,
    setActive,
    status,
    register,
    preparing,
    confirm,
    error,
    valid: props.review.pages.every((page) => status[page.pageId]?.valid),
    count: props.review.pages.reduce(
      (count, page) =>
        count + (status[page.pageId]?.count ?? page.review.regions.length),
      0,
    ),
  };
}
