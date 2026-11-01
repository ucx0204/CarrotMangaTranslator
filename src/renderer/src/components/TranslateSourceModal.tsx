import React from "react";
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
import { Button } from "./ui/Button";

type TranslateSourceModalProps = {
  addingPages?: boolean;
  busy: boolean;
  onCancel: () => void;
  onSelect: (mode: TranslateSourceMode) => void;
};

export function TranslateSourceModal({
  addingPages = false,
  busy,
  onCancel,
  onSelect,
}: TranslateSourceModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <Modal
      size="sm"
      title={t(addingPages ? "import.addPages" : "translateSource.title")}
      onClose={onCancel}
      closeDisabled={busy}
    >
      <div className="source-choice-grid">
        <SourceChoice
          disabled={busy}
          icon={<IconPhoto size={23} stroke={1.8} />}
          label={t("translateSource.openImages")}
          onClick={() => onSelect("images")}
        />
        <SourceChoice
          disabled={busy}
          icon={<IconFolderOpen size={22} stroke={1.8} />}
          label={t("translateSource.openFolder")}
          onClick={() => onSelect("folder")}
        />
        <SourceChoice
          disabled={busy}
          icon={<IconZip size={22} stroke={1.8} />}
          label={t("translateSource.openArchive")}
          detail="ZIP · CBZ · RAR · CBR"
          onClick={() => onSelect("zip")}
        />
        <SourceChoice
          disabled={busy}
          icon={<IconFileTypePdf size={22} stroke={1.8} />}
          label={t("translateSource.openPdf")}
          onClick={() => onSelect("pdf")}
        />
        <SourceChoice
          disabled={busy}
          icon={<IconLink size={22} stroke={1.8} />}
          label={t("translateSource.openWeb")}
          onClick={() => onSelect("web")}
        />
      </div>
      <p className="muted-line modal-note">{t("translateSource.dropHint")}</p>
    </Modal>
  );
}

function SourceChoice({
  disabled,
  icon,
  label,
  detail,
  onClick,
}: {
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
  detail?: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <Button
      type="button"
      className="source-choice"
      disabled={disabled}
      onClick={onClick}
      variant="bare"
    >
      <span className="source-choice-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="source-choice-copy">
        <strong>{label}</strong>
        {detail ? <small>{detail}</small> : null}
      </span>
    </Button>
  );
}
