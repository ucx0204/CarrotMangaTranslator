import React from "react";
import { useTranslation } from "react-i18next";
import {
  createBlockLibrarySaveInput,
  resolveBlockLibraryDefaultName,
} from "../../../shared/blockLibrary";
import type { TranslationBlock } from "../../../shared/textTypes";
import { blockLibraryGateway } from "../api/blockLibraryGateway";
import {
  resolveBlockLibraryError,
  type BlockLibrarySource,
} from "./blockLibraryModel";
import { TextField } from "./ui/Field";
import { Modal } from "./ui/Modal";
import { ModalActionBar, ModalActionButtons } from "./ui/ModalActionBar";
import styles from "./BlockLibraryModals.module.css";

export function SaveBlockLibraryModal({
  block,
  onClose,
  pageSize,
  source = blockLibraryGateway,
}: {
  block: TranslationBlock;
  onClose: () => void;
  pageSize: { width: number; height: number };
  source?: BlockLibrarySource;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const [name, setName] = React.useState(() =>
    resolveBlockLibraryDefaultName(block),
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const trimmedName = name.replace(/\s+/g, " ").trim();
  const save = async (): Promise<void> => {
    if (!trimmedName || busy) return;
    setBusy(true);
    setError("");
    try {
      await source.saveBlockLibraryEntry(
        createBlockLibrarySaveInput(block, pageSize, trimmedName),
      );
      onClose();
    } catch (saveError) {
      setError(
        resolveBlockLibraryError(saveError, t("blockLibrary.saveFailed")),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      size="sm"
      title={t("blockLibrary.saveTitle")}
      onClose={onClose}
      closeDisabled={busy}
      footer={
        <ModalActionBar
          actions={
            <ModalActionButtons
              cancel={{
                label: t("common.cancel"),
                onClick: onClose,
                disabled: busy,
              }}
              confirm={{
                label: t("blockLibrary.save"),
                onClick: () => void save(),
                disabled: busy || !trimmedName,
              }}
            />
          }
        />
      }
    >
      <form
        className={styles.saveForm}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <TextField
          autoFocus
          disabled={busy}
          label={t("blockLibrary.name")}
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {error ? <p className={styles.error}>{error}</p> : null}
      </form>
    </Modal>
  );
}
