import React from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { SettingsSection } from "./SettingsSection";
import { Button } from "../ui/Button";
import { ProgressBar } from "../ui/ProgressBar";
import { Modal } from "../ui/Modal";
import { ModalActionBar, ModalActionButtons } from "../ui/ModalActionBar";
import { useEnvironmentBackup } from "./useEnvironmentBackup";
import styles from "./EnvironmentBackupSection.module.css";

export function EnvironmentBackupSection({
  disabled,
  dirty = false,
}: {
  disabled: boolean;
  dirty?: boolean;
}): React.JSX.Element {
  const model = useEnvironmentBackup();
  return (
    <EnvironmentBackupView model={model} disabled={disabled} dirty={dirty} />
  );
}

export function EnvironmentBackupView({
  model,
  disabled,
  dirty,
}: {
  model: ReturnType<typeof useEnvironmentBackup>;
  disabled: boolean;
  dirty: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const blocked = disabled || dirty || model.busy;
  const confirming = Boolean(model.preview || model.recoveryId);
  return (
    <SettingsSection
      title={t("settings.backup.title")}
      description={t("settings.backup.description")}
    >
      <div className={styles.content}>
        <p>{t("settings.backup.includes")}</p>
        <p className={styles.muted}>{t("settings.backup.excludes")}</p>
        {model.status && (
          <p>{t("settings.backup.counts", model.status.summary)}</p>
        )}
        {dirty && <p role="status">{t("settings.backup.dirty")}</p>}
        <div className={styles.actions}>
          <Button disabled={blocked} onClick={() => void model.exportBackup()}>
            {t("settings.backup.export")}
          </Button>
          <Button disabled={blocked} onClick={() => void model.inspectBackup()}>
            {t("settings.backup.import")}
          </Button>
        </div>
        {model.status?.restored && (
          <p role="status">{t("settings.backup.restored")}</p>
        )}
        {model.status?.recoveries.map((item) => (
          <div key={item.id} className={styles.recovery}>
            <span>{new Date(item.createdAt).toLocaleString()}</span>
            <Button
              size="sm"
              disabled={blocked}
              onClick={() => model.chooseRecovery(item.id)}
            >
              {t("settings.backup.recover")}
            </Button>
          </div>
        ))}
        <BackupConfirmation model={model} blocked={blocked} />
        {!confirming && (
          <>
            <BackupProgress model={model} />
            {model.error && (
              <p role="alert" className={styles.path}>
                {model.error}
              </p>
            )}
          </>
        )}
        {model.savedPath && (
          <p role="status" className={styles.path}>
            {t("settings.backup.saved", { path: model.savedPath })}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}

function BackupConfirmation({
  model,
  blocked,
}: {
  model: ReturnType<typeof useEnvironmentBackup>;
  blocked: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const recovery = model.status?.recoveries.find(
    (item) => item.id === model.recoveryId,
  );
  const preview = model.preview;
  if (!preview && !recovery) return null;
  return createPortal(
    <Modal
      title={t("settings.backup.confirmTitle")}
      onClose={model.dismiss}
      closeDisabled={model.busy}
      bodyClassName={styles.content}
      footer={
        <div className={styles.content}>
          <BackupProgress model={model} />
          {model.error && (
            <p role="alert" className={styles.path}>
              {model.error}
            </p>
          )}
          <ModalActionBar
            actions={
              <ModalActionButtons
                cancel={{
                  label: t("settings.backup.close"),
                  onClick: model.dismiss,
                  disabled: model.busy,
                }}
                confirm={{
                  label: t("settings.backup.apply"),
                  onClick: () => void model.apply(),
                  disabled: blocked,
                }}
              />
            }
          />
        </div>
      }
    >
      {preview && (
        <>
          <p>{t("settings.backup.ready")}</p>
          <strong>{t("settings.backup.counts", preview)}</strong>
          <p className={styles.muted}>
            {new Date(preview.createdAt).toLocaleString()} · v
            {preview.appVersion} · {(preview.bytes / 1024 ** 2).toFixed(1)} MB
          </p>
        </>
      )}
      <p>{t("settings.backup.confirmDescription")}</p>
      <p className={styles.path}>{preview?.recoveryPath ?? recovery?.path}</p>
      {preview?.connections.map((connection) => (
        <p className={styles.path} key={connection}>
          {connection}
        </p>
      ))}
    </Modal>,
    document.body,
  );
}
function BackupProgress({
  model,
}: {
  model: ReturnType<typeof useEnvironmentBackup>;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (!model.busy) return null;
  return (
    <div className={styles.content} aria-live="polite">
      <ProgressBar
        label={t("settings.backup.progress")}
        mode={model.activity?.progressTotal ? "determinate" : "indeterminate"}
        value={model.activity?.progressCurrent}
        max={model.activity?.progressTotal}
      />
      <span>{t("settings.backup.progress")}</span>
      {model.activity?.cancellable && (
        <div className={styles.actions}>
          <Button onClick={model.cancel}>{t("settings.backup.cancel")}</Button>
        </div>
      )}
    </div>
  );
}
