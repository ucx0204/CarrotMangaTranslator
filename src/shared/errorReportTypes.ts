export const ERROR_REPORT_MAX_BYTES = 60 * 1024;
export const ERROR_REPORT_LOG_MAX_BYTES = 48 * 1024;
export const ERROR_REPORT_GITHUB_URL_MAX_LENGTH = 7000;
export const ERROR_REPORT_MAX_LOG_ENTRIES = 200;

export type ErrorReportSource =
  | "manual"
  | "job-failure"
  | "react-boundary"
  | "renderer-global"
  | "main-process"
  | "renderer-process";

export type ErrorReportContext = {
  source: ErrorReportSource;
  summary?: string;
  message?: string;
  stack?: string;
  componentStack?: string;
  jobStage?: string;
};

export type ErrorReportDraft = {
  defaultTitle: string;
  errorMarkdown: string;
  systemMarkdown: string;
  logsMarkdown: string;
  redactionCount: number;
  truncated: boolean;
};

export type OpenErrorReportIssueRequest = {
  title: string;
  body: string;
};

export type OpenErrorReportIssueResult = {
  opened: boolean;
  mode: "prefilled" | "clipboard";
};

export type CopyErrorReportResult = {
  copied: boolean;
};

export type RestartAppResult = {
  restarting: boolean;
};
