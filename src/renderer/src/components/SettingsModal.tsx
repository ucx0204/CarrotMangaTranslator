import { ErrorBoundary } from "./ErrorBoundary";
import React from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "../../../shared/settingsTypes";
import type { LibraryIndex } from "../../../shared/libraryTypes";
import { ConfirmModal } from "./ConfirmModal";
import { SettingsModalView } from "./settingsModal/SettingsModalView";
import { useSettingsModalController } from "./settingsModal/useSettingsModalController";
import type { SettingsOpenRequest } from "../hooks/useSettingsDialog";
import {
  SettingsRecoveryModal,
  type SettingsRecoveryActions,
} from "./SettingsRecoveryModal";

type SettingsModalProps = {
  initialSettings: AppSettings | null;
  recovery?: SettingsRecoveryActions;
  library?: LibraryIndex;
  busy: boolean;
  jobActive: boolean;
  openRequest?: SettingsOpenRequest;
  onCancel: () => void;
  onOpenErrorReport: () => void;
  onOpenLogFolder: () => void;
  onOpenModelFolder: () => void;
  onReset: () => Promise<AppSettings | null>;
  onSubmit: (settings: AppSettings) => void;
};

function SettingsModalContent({
  initialSettings,
  library,
  busy,
  jobActive,
  openRequest,
  onCancel,
  onOpenErrorReport,
  onOpenLogFolder,
  onOpenModelFolder,
  onReset,
  onSubmit,
}: SettingsModalProps & { initialSettings: AppSettings }): React.JSX.Element {
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
    openRequest,
    onOpenErrorReport,
    onOpenLogFolder,
    onOpenModelFolder,
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

export function SettingsModal(props: SettingsModalProps): React.JSX.Element {
  if (!props.initialSettings) {
    return (
      <SettingsRecoveryModal
        failure={props.recovery?.failure ?? null}
        onRetry={props.recovery?.onRetry ?? props.onCancel}
        onRecover={props.recovery?.onRecover ?? props.onCancel}
        busy={props.busy}
        jobActive={props.jobActive}
        onCancel={props.onCancel}
        onOpenLogFolder={props.onOpenLogFolder}
      />
    );
  }
  return (
    <ErrorBoundary onRecover={props.onCancel}>
      <SettingsModalContent
        {...props}
        initialSettings={props.initialSettings}
      />
    </ErrorBoundary>
  );
}
