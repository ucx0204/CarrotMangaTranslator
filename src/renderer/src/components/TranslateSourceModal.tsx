import React from "react";
import { ControlTooltip } from "./ui/ControlTooltip";
import {
  IconFileTypePdf,
  IconFolderOpen,
  IconLink,
  IconPhoto,
  IconZip,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { TranslateSourceMode } from "../lib/importFlowTypes";
import { Modal } from "./ui/Modal";
import { ModalActionBar, ModalActionButtons } from "./ui/ModalActionBar";

type TranslateSourceModalProps = {
  busy: boolean;
  onCancel: () => void;
  onSelect: (mode: TranslateSourceMode) => void;
};

export function TranslateSourceModal({
  busy,
  onCancel,
  onSelect,
}: TranslateSourceModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <Modal
      size="sm"
      title={t("translateSource.title")}
      onClose={onCancel}
      closeDisabled={busy}
      footer={
        <ModalActionBar
          actions={
            <ModalActionButtons
              cancel={{
                label: t("common.cancel"),
                onClick: onCancel,
                disabled: busy,
              }}
            />
          }
        />
      }
    >
      <div className="source-choice-grid">
        <SourceChoice
          disabled={busy}
          icon={<IconPhoto size={23} stroke={1.8} />}
          label={t("translateSource.openImages")}
          description={t("translateSource.imagesHint")}
          onClick={() => onSelect("images")}
        />
        <SourceChoice
          disabled={busy}
          icon={<IconFolderOpen size={22} stroke={1.8} />}
          label={t("translateSource.openFolder")}
          description={t("translateSource.folderHint")}
          onClick={() => onSelect("folder")}
        />
        <SourceChoice
          disabled={busy}
          icon={<IconZip size={22} stroke={1.8} />}
          label={t("translateSource.openArchive")}
          description={t("translateSource.archiveHint")}
          onClick={() => onSelect("zip")}
        />
        <SourceChoice
          disabled={busy}
          icon={<IconFileTypePdf size={22} stroke={1.8} />}
          label={t("translateSource.openPdf")}
          description={t("translateSource.pdfHint")}
          onClick={() => onSelect("pdf")}
        />
        <SourceChoice
          disabled={busy}
          icon={<IconLink size={22} stroke={1.8} />}
          label={t("translateSource.openWeb")}
          description={t("translateSource.webHint")}
          onClick={() => onSelect("web")}
        />
      </div>
    </Modal>
  );
}

function SourceChoice({
  description,
  disabled,
  icon,
  label,
  onClick,
}: {
  description: string;
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <ControlTooltip floating content={description}>
      <button
        type="button"
        className="source-choice"
        disabled={disabled}
        onClick={onClick}
      >
        <span className="source-choice-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="source-choice-copy">
          <strong>{label}</strong>
        </span>
      </button>
    </ControlTooltip>
  );
}
