import { ControlTooltip } from "../ui/ControlTooltip";
import React from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { SettingsSection } from "./SettingsSection";
import { Button } from "../ui/Button";
import { CollapsibleSection } from "../ui/Section";
import { formatBytes } from "../../lib/jobProgressFormatting";
import { ProgressBar } from "../ui/ProgressBar";
import { Modal } from "../ui/Modal";
import { ModalActionBar, ModalActionButtons } from "../ui/ModalActionBar";
import { useEnvironmentBackup } from "./useEnvironmentBackup";
import styles from "./EnvironmentBackupSection.module.css";
import { PartialBackupContent } from "./PartialBackupContent";
import type { GlossaryTargets } from "../../../../shared/environmentBackup";

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
    <SettingsSection title={t("settings.backup.title")}>
      <div className={styles.content}>
        <p className={styles.muted}>{t("settings.backup.excludes")}</p>
        {model.status && (
          <p>{t("settings.backup.counts", model.status.summary)}</p>
        )}
        {dirty && <p role="status">{t("settings.backup.dirty")}</p>}
        <div className={styles.actions}>
          <ControlTooltip content={t("settings.backup.includes")}>
            <Button
              disabled={blocked}
              onClick={() => void model.exportBackup()}
            >
              {t("settings.backup.export")}
            </Button>
          </ControlTooltip>
          <ControlTooltip content={t("settings.backup.excludesHelp")}>
            <Button
              disabled={blocked}
              onClick={() => void model.inspectBackup()}
            >
              {t("settings.backup.import")}
            </Button>
          </ControlTooltip>
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
        <BackupConfirmation
          key={confirmationKey(model)}
          model={model}
          blocked={blocked}
        />
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

function confirmationKey(model: ReturnType<typeof useEnvironmentBackup>) {
  return model.preview?.id ?? model.recoveryId;
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
  const [targets, setTargets] = React.useState<GlossaryTargets>([]);
  if (!preview && !recovery) return null;
  return createPortal(
    <Modal
      title={t(
        preview?.partial
          ? "settings.backup.partial.title"
          : "settings.backup.confirmTitle",
      )}
      onClose={model.dismiss}
      closeDisabled={model.busy}
      bodyClassName={styles.content}
      footer={
        <BackupFooter
          model={model}
          blocked={blocked}
          label={t(
            preview?.partial
              ? "settings.backup.partial.apply"
              : "settings.backup.apply",
          )}
          onApply={() => void model.apply(targets)}
        />
      }
    >
      {preview?.partial ? (
        <PartialBackupContent
          partial={preview.partial}
          targets={targets}
          setTargets={setTargets}
          disabled={blocked}
        />
      ) : (
        <FullRestoreContent preview={preview} recoveryPath={recovery?.path} />
      )}
    </Modal>,
    document.body,
  );
}
function FullRestoreContent({
  preview,
  recoveryPath,
}: {
  preview: ReturnType<typeof useEnvironmentBackup>["preview"];
  recoveryPath?: string;
}) {
  const { t, i18n } = useTranslation("components");
  const [expanded, setExpanded] = React.useState(false);
  return (
    <>
      {preview && <strong>{t("settings.backup.counts", preview)}</strong>}
      <p>{t("settings.backup.confirmDescription")}</p>
      <CollapsibleSection
        density="compact"
        title={t("settings.backup.details")}
        expanded={expanded}
        onExpandedChange={setExpanded}
        bodyClassName={styles.content}
      >
        {preview && (
          <p className={styles.muted}>
            {new Date(preview.createdAt).toLocaleString(i18n.language)} · v
            {preview.appVersion} · {formatBytes(preview.bytes, i18n.language)}
          </p>
        )}
        <div>
          <span className={styles.muted}>
            {t(
              preview
                ? "settings.backup.previousLocation"
                : "settings.backup.restoreFrom",
            )}
          </span>
          <p className={styles.path}>{preview?.recoveryPath ?? recoveryPath}</p>
        </div>
        {preview && preview.connections.length > 0 && (
          <div>
            <span className={styles.muted}>
              {t("settings.backup.reconnectFolders")}
            </span>
            {preview.connections.map((connection) => (
              <p className={styles.path} key={connection}>
                {connection}
              </p>
            ))}
          </div>
        )}
      </CollapsibleSection>
    </>
  );
}
function BackupFooter({
  model,
  blocked,
  label,
  onApply,
}: {
  model: ReturnType<typeof useEnvironmentBackup>;
  blocked: boolean;
  label: string;
  onApply: () => void;
}) {
  const { t } = useTranslation("components");
  return (
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
              label: label,
              onClick: onApply,
              disabled: blocked,
            }}
          />
        }
      />
    </div>
  );
}
function BackupProgress({
  model,
}: {
  model: ReturnType<typeof useEnvironmentBackup>;
}): React.JSX.Element | null {
  const { t } = useTranslation(["components", "renderer"]);
  if (!model.busy) return null;
  const label = model.activity?.phase
    ? t(`renderer:statusDock.operation.phase.${model.activity.phase}`)
    : t("settings.backup.progress");
  return (
    <div className={styles.content} aria-live="polite">
      <ProgressBar
        label={label}
        mode={model.activity?.progressTotal ? "determinate" : "indeterminate"}
        value={model.activity?.progressCurrent}
        max={model.activity?.progressTotal}
      />
      <span>{label}</span>
      {model.activity?.cancellable && (
        <div className={styles.actions}>
          <Button onClick={model.cancel}>{t("settings.backup.cancel")}</Button>
        </div>
      )}
    </div>
  );
}
