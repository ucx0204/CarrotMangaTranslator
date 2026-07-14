import React from "react";
import { useTranslation } from "react-i18next";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { JobState } from "../../../shared/jobTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { useEtaText } from "../hooks/useEtaText";
import { Button } from "./ui";
import { ChevronDownIcon, CopyIcon, InfoIcon } from "./ui/icons";

export function RunPanel({
  currentChapter,
  jobActive,
  flowActive,
  showProgressBar,
  progressSnapshot,
  jobState,
  onOpenExport,
  onOpenTranslateOptions,
  onOpenAutoInpaintingOptions,
  onRunCurrentPageInpainting,
  onShowGuide,
  onCancelJob,
  hasSelectedPage,
}: {
  currentChapter: ChapterSnapshot | null;
  jobActive: boolean;
  flowActive: boolean;
  showProgressBar: boolean;
  progressSnapshot: ProgressSnapshot | null;
  jobState: JobState;
  onOpenExport: () => void;
  onOpenTranslateOptions: () => void;
  onOpenAutoInpaintingOptions: () => void;
  onRunCurrentPageInpainting: () => void;
  onShowGuide: () => void;
  onCancelJob: () => void;
  hasSelectedPage: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const actionsDisabled = !currentChapter || jobActive || flowActive;
  return (
    <section className="run-panel">
      <div className="run-title">
        <h2>{currentChapter?.title ?? t("sidebar.noCurrentChapter")}</h2>
        <small>
          {currentChapter
            ? t("common.pageCount", { count: currentChapter.pages.length })
            : t("runPanel.openChapterHint")}
        </small>
      </div>
      <div className="run-primary-actions">
        <Button
          variant="primary"
          fullWidth
          onClick={onOpenTranslateOptions}
          disabled={actionsDisabled}
        >
          {t("sidebar.translate")}
        </Button>
        <AutomaticEraseActions
          disabled={actionsDisabled || !hasSelectedPage}
          onOpenMultiPage={onOpenAutoInpaintingOptions}
          onRunCurrentPage={onRunCurrentPageInpainting}
          onShowGuide={onShowGuide}
        />
        <Button fullWidth onClick={onOpenExport} disabled={actionsDisabled}>
          {t("inpainting.export.pngAction")}
        </Button>
      </div>
      {jobActive ? (
        <Button variant="danger" fullWidth onClick={onCancelJob}>
          {t("common.cancel")}
        </Button>
      ) : null}
      {showProgressBar && progressSnapshot ? (
        <ProgressCard jobState={jobState} progressSnapshot={progressSnapshot} />
      ) : null}
    </section>
  );
}

function AutomaticEraseActions({
  disabled,
  onOpenMultiPage,
  onRunCurrentPage,
  onShowGuide,
}: {
  disabled: boolean;
  onOpenMultiPage: () => void;
  onRunCurrentPage: () => void;
  onShowGuide: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const [menuOpen, setMenuOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);

  React.useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () =>
      document.removeEventListener("pointerdown", closeOutside, true);
  }, [menuOpen]);

  React.useEffect(() => {
    if (disabled) setMenuOpen(false);
  }, [disabled]);

  React.useEffect(() => {
    if (!menuOpen) return;
    rootRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus();
  }, [menuOpen]);

  const closeMenuAndRestoreFocus = (): void => {
    setMenuOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="auto-inpainting-action" ref={rootRef}>
      <Button fullWidth onClick={onRunCurrentPage} disabled={disabled}>
        {t("inpainting.auto.currentPageAction")}
      </Button>
      <Button
        ref={triggerRef}
        className="auto-inpainting-menu-trigger"
        variant="ghost"
        aria-label={t("inpainting.auto.moreActions")}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={disabled}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <ChevronDownIcon size={16} />
      </Button>
      {menuOpen && !disabled ? (
        <AutomaticEraseMenu
          onClose={closeMenuAndRestoreFocus}
          onOpenMultiPage={onOpenMultiPage}
          onShowGuide={onShowGuide}
        />
      ) : null}
    </div>
  );
}

function AutomaticEraseMenu({
  onClose,
  onOpenMultiPage,
  onShowGuide,
}: {
  onClose: () => void;
  onOpenMultiPage: () => void;
  onShowGuide: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const runAndClose = (action: () => void): void => {
    onClose();
    action();
  };
  return (
    <div
      className="auto-inpainting-menu"
      role="menu"
      aria-label={t("inpainting.auto.moreActions")}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => runAndClose(onOpenMultiPage)}
      >
        <CopyIcon size={16} />
        <span>{t("inpainting.auto.selectMultiplePages")}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => runAndClose(onShowGuide)}
      >
        <InfoIcon size={16} />
        <span>{t("inpainting.auto.guideAction")}</span>
      </button>
    </div>
  );
}

export function StatusPanel({
  jobState,
  statusLines,
}: {
  jobState: JobState;
  statusLines: string[];
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="status-panel">
      <h2>{t("status.title")}</h2>
      <div
        className={`job-pill ${jobState.status}`}
        role="status"
        aria-live="polite"
      >
        {jobState.progressText}
      </div>
      <div className="status-log-scroll">
        {statusLines.length ? (
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

function ProgressCard({
  jobState,
  progressSnapshot,
}: {
  jobState: JobState;
  progressSnapshot: ProgressSnapshot;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const etaText = useEtaText(progressSnapshot);
  return (
    <div className="progress-card">
      <div className="progress-meta">
        <span>{jobState.progressText}</span>
        {progressSnapshot.mode === "determinate" ? (
          <strong>
            {progressSnapshot.current} / {progressSnapshot.total}
          </strong>
        ) : (
          <strong>{t("common.preparing")}</strong>
        )}
      </div>
      {jobState.detail ? (
        <small className="progress-detail">{jobState.detail}</small>
      ) : null}
      {etaText ? <small className="progress-eta">{etaText}</small> : null}
      <div
        className={`progress-track ${progressSnapshot.mode === "indeterminate" ? "indeterminate" : ""}`}
        aria-hidden="true"
      >
        <div
          className={`progress-fill ${progressSnapshot.mode === "indeterminate" ? "indeterminate" : ""}`}
          style={
            progressSnapshot.mode === "determinate"
              ? { width: `${Math.round(progressSnapshot.ratio * 100)}%` }
              : undefined
          }
        />
      </div>
    </div>
  );
}
