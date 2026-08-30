import React from "react";
import {
  IconFiles,
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
      <div className="source-choice-intro">
        <span className="source-choice-intro-icon" aria-hidden="true">
          <IconFiles size={22} stroke={1.9} />
        </span>
        <div>
          <strong>{t("translateSource.prompt")}</strong>
          <span>{t("translateSource.supportedFormats")}</span>
        </div>
      </div>
      <div className="source-choice-grid">
        <SourceChoice
          description={t("translateSource.imagesHint")}
          disabled={busy}
          icon={<IconPhoto size={23} stroke={1.8} />}
          label={t("translateSource.openImages")}
          onClick={() => onSelect("images")}
        />
        <SourceChoice
          description={t("translateSource.folderHint")}
          disabled={busy}
          icon={<IconFolderOpen size={22} stroke={1.8} />}
          label={t("translateSource.openFolder")}
          onClick={() => onSelect("folder")}
        />
        <SourceChoice
          description={t("translateSource.archiveHint")}
          disabled={busy}
          icon={<IconZip size={22} stroke={1.8} />}
          label={t("translateSource.openArchive")}
          onClick={() => onSelect("zip")}
        />
        <SourceChoice
          description={t("translateSource.pdfHint")}
          disabled={busy}
          icon={<IconFileTypePdf size={22} stroke={1.8} />}
          label={t("translateSource.openPdf")}
          onClick={() => onSelect("pdf")}
        />
        <SourceChoice
          description={t("translateSource.webHint")}
          disabled={busy}
          icon={<IconLink size={22} stroke={1.8} />}
          label={t("translateSource.openWeb")}
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
        <small>{description}</small>
      </span>
    </button>
  );
}
