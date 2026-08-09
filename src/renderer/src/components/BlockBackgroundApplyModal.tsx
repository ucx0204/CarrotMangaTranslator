import React from "react";
import { useTranslation } from "react-i18next";
import type { BlockBackgroundApplyScope } from "../hooks/useApplyBlockBackgroundOpacityAction";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { ModalActionBar } from "./ui/ModalActionBar";
import { SelectionSurface } from "./ui/SelectionCard";

type BlockBackgroundApplyModalProps = {
  disableChapterApply: boolean;
  onApply: (scope: BlockBackgroundApplyScope) => void;
  onClose: () => void;
};

export function BlockBackgroundApplyModal({
  disableChapterApply,
  onApply,
  onClose,
}: BlockBackgroundApplyModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const [scope, setScope] = React.useState<BlockBackgroundApplyScope>("page");
  const apply = (): void => {
    onApply(scope);
    onClose();
  };
  return (
    <Modal
      title={t("editor.display.batchTitle")}
      ariaLabel={t("editor.display.batchTitle")}
      closeOnBackdrop
      onClose={onClose}
      size="sm"
      footer={
        <ModalActionBar
          actions={
            <>
              <Button variant="ghost" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" onClick={apply}>
                {t("common.apply")}
              </Button>
            </>
          }
        />
      }
    >
      <p className="muted-line modal-note">
        {t("editor.display.batchDescription")}
      </p>
      <div className="format-apply-section">
        <div className="format-apply-section-head">
          <span>{t("formatBatch.scope")}</span>
        </div>
        <div className="format-apply-scope background-opacity-scope">
          <ScopeButton
            active={scope === "page"}
            label={t("formatBatch.thisPage")}
            onClick={() => setScope("page")}
          />
          <ScopeButton
            active={scope === "chapter"}
            disabled={disableChapterApply}
            label={t("formatBatch.entireChapter")}
            title={
              disableChapterApply ? t("formatBatch.chapterDisabled") : undefined
            }
            onClick={() => setScope("chapter")}
          />
        </div>
      </div>
    </Modal>
  );
}

function ScopeButton({
  active,
  disabled = false,
  label,
  onClick,
  title,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  title?: string;
}): React.JSX.Element {
  return (
    <SelectionSurface
      as="button"
      type="button"
      className="format-apply-scope-button"
      selected={active}
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
      title={title}
    >
      {label}
    </SelectionSurface>
  );
}
