import React from "react";
import { useTranslation } from "react-i18next";
import { SETTINGS_CREDENTIALS_UNAVAILABLE } from "../../../shared/settingsSecrets";
import { Modal } from "./ui/Modal";
import { ModalActionBar, ModalActionButtons } from "./ui/ModalActionBar";
import { InlineMessage } from "./ui/InlineMessage";
import { Button } from "./ui/Button";
import { CheckboxField } from "./ui/CheckboxField";

export type SettingsRecoveryActions = {
  failure: string | null;
  onRetry: () => void;
  onRecover: () => void;
};

export function SettingsRecoveryModal({
  failure,
  onRetry,
  onRecover,
  busy,
  jobActive,
  onCancel,
  onOpenLogFolder,
}: SettingsRecoveryActions & {
  busy: boolean;
  jobActive: boolean;
  onCancel: () => void;
  onOpenLogFolder: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const [confirmed, setConfirmed] = React.useState(false);
  const credentialsUnavailable =
    failure?.includes(SETTINGS_CREDENTIALS_UNAVAILABLE) === true;
  return (
    <Modal
      title={t("settings.recovery.title")}
      size="sm"
      onClose={onCancel}
      closeDisabled={busy}
      footer={
        <RecoveryFooter
          busy={busy}
          onOpenLogFolder={onOpenLogFolder}
          onCancel={onCancel}
          onRetry={onRetry}
        />
      }
    >
      <InlineMessage
        variant="danger"
        title={t(
          credentialsUnavailable
            ? "settings.recovery.credentialsTitle"
            : "settings.recovery.loadTitle",
        )}
        detail={t(
          credentialsUnavailable
            ? "settings.recovery.credentialsDetail"
            : "settings.recovery.loadDetail",
        )}
      />
      {credentialsUnavailable ? (
        <>
          <p>{t("settings.recovery.preserve")}</p>
          <CheckboxField
            label={t("settings.recovery.confirm")}
            checked={confirmed}
            disabled={busy || jobActive}
            onCheckedChange={setConfirmed}
          />
          <Button
            variant="danger"
            disabled={!confirmed || busy || jobActive}
            onClick={onRecover}
          >
            {t("settings.recovery.recover")}
          </Button>
        </>
      ) : null}
      {busy ? <p role="status">{t("settings.recovery.busy")}</p> : null}
      {jobActive ? (
        <p role="status">{t("settings.recovery.waitForJob")}</p>
      ) : null}
    </Modal>
  );
}

function RecoveryFooter({
  busy,
  onOpenLogFolder,
  onCancel,
  onRetry,
}: {
  busy: boolean;
  onOpenLogFolder: () => void;
  onCancel: () => void;
  onRetry: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <ModalActionBar
      leading={
        <Button disabled={busy} onClick={onOpenLogFolder}>
          {t("settings.recovery.logs")}
        </Button>
      }
      actions={
        <ModalActionButtons
          cancel={{
            label: t("common.close"),
            onClick: onCancel,
            disabled: busy,
          }}
          confirm={{
            label: t("settings.recovery.retry"),
            onClick: onRetry,
            disabled: busy,
          }}
        />
      }
    />
  );
}
