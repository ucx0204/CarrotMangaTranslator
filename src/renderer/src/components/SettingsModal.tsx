import React from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "../../../shared/settingsTypes";
import type { LibraryIndex } from "../../../shared/libraryTypes";
import { ConfirmModal } from "./ConfirmModal";
import { SettingsModalView } from "./settingsModal/SettingsModalView";
import { useSettingsModalController } from "./settingsModal/useSettingsModalController";

type SettingsModalProps = {
  initialSettings: AppSettings;
  library?: LibraryIndex;
  busy: boolean;
  jobActive: boolean;
  onCancel: () => void;
  onOpenLogFolder: () => void;
  onReset: () => Promise<AppSettings | null>;
  onSubmit: (settings: AppSettings) => void;
};

export function SettingsModal({
  initialSettings,
  library,
  busy,
  jobActive,
  onCancel,
  onOpenLogFolder,
  onReset,
  onSubmit,
}: SettingsModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const [isDirty, setIsDirty] = React.useState(false);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = React.useState(false);
  const requestClose = React.useCallback(() => {
    if (isDirty) {
      setConfirmDiscardOpen(true);
      return;
    }
    onCancel();
  }, [isDirty, onCancel]);
  const controller = useSettingsModalController({
    initialSettings,
    busy,
    jobActive,
    onOpenLogFolder,
    onReset,
    onSubmit,
    onCancel: requestClose,
    onDirtyChange: setIsDirty,
  });
  return (
    <>
      <SettingsModalView {...controller} library={library} />
      {confirmDiscardOpen ? (
        <ConfirmModal
          title={t("settings.unsavedChanges.title")}
          message={t("settings.unsavedChanges.message")}
          detail={t("settings.unsavedChanges.detail")}
          confirmLabel={t("settings.unsavedChanges.discard")}
          confirmVariant="danger"
          onCancel={() => setConfirmDiscardOpen(false)}
          onConfirm={onCancel}
        />
      ) : null}
    </>
  );
}
