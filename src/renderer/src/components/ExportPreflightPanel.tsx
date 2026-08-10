import React from "react";
import { useTranslation } from "react-i18next";
import type {
  PageImageExportPreflightIssue,
  PageImageExportPreflightResult,
} from "../../../shared/pageImageExportTypes";

export type ExportIssueNavigationHandler = (
  chapterId: string,
  pageId: string,
) => void;

export type ExportPreflightState =
  | { status: "idle" | "loading"; result: null; error: null }
  | { status: "ready"; result: PageImageExportPreflightResult; error: null }
  | { status: "error"; result: null; error: string };

export function ExportPreflightPanel({
  onNavigateToIssue,
  preflight,
}: {
  onNavigateToIssue?: ExportIssueNavigationHandler;
  preflight: ExportPreflightState;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section
      className="export-preflight"
      aria-label={t("exportOptions.preflight.title")}
    >
      <div className="export-preflight-header">
        <div>
          <strong>{t("exportOptions.preflight.title")}</strong>
          <span>{t("exportOptions.preflight.nextStep")}</span>
        </div>
        <PreflightStatus state={preflight} />
      </div>
      <ExportPreflightContent
        preflight={preflight}
        onNavigateToIssue={onNavigateToIssue}
      />
    </section>
  );
}

function ExportPreflightContent({
  onNavigateToIssue,
  preflight,
}: {
  onNavigateToIssue?: ExportIssueNavigationHandler;
  preflight: ExportPreflightState;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  if (preflight.status === "ready") {
    return (
      <ReadyExportPreflight
        result={preflight.result}
        onNavigateToIssue={onNavigateToIssue}
      />
    );
  }
  if (preflight.status === "error") {
    return (
      <p className="export-preflight-error" role="alert">
        {t("exportOptions.preflight.failed")}
        <small>{preflight.error}</small>
      </p>
    );
  }
  return (
    <p className="export-preflight-loading">
      {t("exportOptions.preflight.checking")}
    </p>
  );
}

function PreflightStatus({
  state,
}: {
  state: ExportPreflightState;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (state.status !== "ready") return null;
  const warningCount = state.result.issues.filter(
    (issue) => issue.severity === "warning",
  ).length;
  return (
    <span
      className={`export-preflight-status ${warningCount ? "warning" : "ready"}`}
    >
      {warningCount
        ? t("exportOptions.preflight.warningCount", { count: warningCount })
        : t("exportOptions.preflight.ready")}
    </span>
  );
}

function ReadyExportPreflight({
  onNavigateToIssue,
  result,
}: {
  onNavigateToIssue?: ExportIssueNavigationHandler;
  result: PageImageExportPreflightResult;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <div className="export-preflight-summary">
        <span>
          {t("exportOptions.preflight.chapterCount", {
            count: result.chapterCount,
          })}
        </span>
        <span>
          {t("exportOptions.preflight.pageCount", { count: result.pageCount })}
        </span>
        <span>{t("exportOptions.preflight.noOverwrite")}</span>
      </div>
      <div className="export-preflight-sample">
        <span>{t("exportOptions.preflight.sample")}</span>
        <code>{result.sampleRelativePath}</code>
      </div>
      {result.issues.length > 0 ? (
        <ExportPreflightIssues
          issues={result.issues}
          onNavigateToIssue={onNavigateToIssue}
        />
      ) : (
        <p className="export-preflight-clear">
          {t("exportOptions.preflight.noIssues")}
        </p>
      )}
    </>
  );
}

function ExportPreflightIssues({
  issues,
  onNavigateToIssue,
}: {
  issues: PageImageExportPreflightIssue[];
  onNavigateToIssue?: ExportIssueNavigationHandler;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const visible = issues.slice(0, 5);
  return (
    <div className="export-preflight-issues">
      {visible.map((issue, index) => (
        <div key={`${issue.chapterId}:${issue.pageId}:${issue.code}:${index}`}>
          <span className={`export-preflight-issue-dot ${issue.severity}`} />
          <span>
            <strong>{issue.pageName}</strong>
            <small>{t(`exportOptions.preflight.issues.${issue.code}`)}</small>
          </span>
          {onNavigateToIssue ? (
            <button
              type="button"
              onClick={() => onNavigateToIssue(issue.chapterId, issue.pageId)}
            >
              {t("exportOptions.preflight.openPage")}
            </button>
          ) : null}
        </div>
      ))}
      {issues.length > visible.length ? (
        <small>
          {t("exportOptions.preflight.moreIssues", {
            count: issues.length - visible.length,
          })}
        </small>
      ) : null}
    </div>
  );
}
