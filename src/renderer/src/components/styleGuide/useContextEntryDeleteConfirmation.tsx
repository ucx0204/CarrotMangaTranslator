import React from "react";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "../../hooks/useConfirmDialog";
import { ConfirmModal } from "../ConfirmModal";

export function useContextEntryDeleteConfirmation(): {
  confirmDelete: (count: number) => Promise<boolean>;
  confirmationModal: React.JSX.Element | null;
} {
  const { t } = useTranslation("components");
  const { askConfirm, confirmDialog, resolveConfirmDialog } =
    useConfirmDialog();
  const confirmDelete = React.useCallback(
    (count: number) =>
      askConfirm(
        t("styleGuide.usage.deleteSelected", { count }),
        t("styleGuide.usage.deleteConfirm", { count }),
      ),
    [askConfirm, t],
  );
  const confirmationModal = confirmDialog ? (
    <ConfirmModal
      title={confirmDialog.title}
      message={confirmDialog.message}
      confirmLabel={t("common.delete")}
      confirmVariant="danger"
      onCancel={() => resolveConfirmDialog(false)}
      onConfirm={() => resolveConfirmDialog(true)}
    />
  ) : null;
  return { confirmDelete, confirmationModal };
}
