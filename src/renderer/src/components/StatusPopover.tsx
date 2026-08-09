import React from "react";
import { IconTrash, IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { JobState } from "../../../shared/jobTypes";
import { IconButton } from "./ui/IconButton";

export function StatusPopover({
  id,
  jobState,
  statusLines,
  onClear,
  onClose,
}: {
  id: string;
  jobState: JobState;
  statusLines: string[];
  onClear: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section
      id={id}
      className="status-popover"
      aria-label={t("statusDock.title")}
      role="dialog"
    >
      <header>
        <div>
          <h2>{t("statusDock.title")}</h2>
          <span>
            {t("statusDock.recentCount", { count: statusLines.length })}
          </span>
        </div>
        <div className="status-popover-actions">
          <IconButton
            size="sm"
            label={t("statusDock.clear")}
            title={t("statusDock.clear")}
            disabled={statusLines.length === 0}
            onClick={onClear}
          >
            <IconTrash size={15} aria-hidden="true" />
          </IconButton>
          <IconButton
            size="sm"
            label={t("statusDock.close")}
            title={t("statusDock.close")}
            onClick={onClose}
          >
            <IconX size={16} aria-hidden="true" />
          </IconButton>
        </div>
      </header>
      <div
        className={`job-pill ${jobState.status}`}
        role="status"
        aria-live="polite"
      >
        {jobState.progressText}
      </div>
      <div className="status-popover-log">
        {statusLines.length > 0 ? (
          statusLines.map((line, index) => (
            <p key={`${line}-${index}`}>{line}</p>
          ))
        ) : (
          <p className="muted-line">{t("status.empty")}</p>
        )}
      </div>
    </section>
  );
}
