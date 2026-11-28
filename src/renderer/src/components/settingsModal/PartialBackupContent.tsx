import React from "react";
import { useTranslation } from "react-i18next";
import type {
  BackupPreview,
  GlossaryTargets,
} from "../../../../shared/environmentBackup";
import { Select } from "../ui/Select";
import { Button } from "../ui/Button";
import styles from "./EnvironmentBackupSection.module.css";

export function PartialBackupContent({
  partial,
  targets,
  setTargets,
  disabled,
}: {
  partial: NonNullable<BackupPreview["partial"]>;
  targets: GlossaryTargets;
  setTargets: (targets: GlossaryTargets) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation("components");
  const options = [
    { value: "", label: t("settings.backup.partial.newWork") },
    ...partial.targets.map((work) => ({ value: work.id, label: work.title })),
  ];
  return (
    <>
      <p>{t("settings.backup.partial.description")}</p>
      {partial.items.map((item) => (
        <div key={item.sourceId} className={styles.item}>
          <strong className={styles.path}>{item.title}</strong>
          {item.sample?.length ? (
            <p className={styles.path}>{item.sample.join(" · ")}</p>
          ) : null}
          <p className={styles.muted}>
            {t("settings.backup.partial.counts", item)}
          </p>
          {!item.chapters && item.terms > 0 && partial.targets.length > 0 && (
            <>
              <span>{t("settings.backup.partial.destination")}</span>
              <Select
                ariaLabel={
                  t("settings.backup.partial.destination") + " · " + item.title
                }
                options={options}
                disabled={disabled}
                value={
                  targets.find((choice) => choice.sourceId === item.sourceId)
                    ?.workId ?? ""
                }
                onValueChange={(workId) =>
                  setTargets([
                    ...targets.filter(
                      (choice) => choice.sourceId !== item.sourceId,
                    ),
                    ...(workId ? [{ sourceId: item.sourceId, workId }] : []),
                  ])
                }
              />
            </>
          )}
        </div>
      ))}
      {targets.length > 0 && (
        <p className={styles.muted}>{t("settings.backup.partial.keep")}</p>
      )}
      {partial.issueCount > 0 && <RecoveryIssues partial={partial} />}
    </>
  );
}

function RecoveryIssues({
  partial,
}: {
  partial: NonNullable<BackupPreview["partial"]>;
}) {
  const { t } = useTranslation("components");
  const [details, setDetails] = React.useState(false);
  return (
    <div>
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={details}
        onClick={() => setDetails(!details)}
      >
        {t("settings.backup.partial.details", {
          count: partial.issueCount,
        })}
      </Button>
      {details && (
        <ul className={styles.path}>
          {partial.issues.map((issue, index) => (
            <li key={index}>{issue}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
