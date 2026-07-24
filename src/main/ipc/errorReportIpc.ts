import { app, clipboard, shell } from "electron";
import {
  APP_MAC_ALPHA_ISSUE_URL,
  APP_NEW_ISSUE_URL,
} from "../../shared/appRelease";
import { errorReportIpcContracts } from "../../shared/ipcContracts";
import {
  ERROR_REPORT_GITHUB_URL_MAX_LENGTH,
  type ErrorReportContext,
  type ErrorReportDraft,
  type OpenErrorReportIssueResult,
} from "../../shared/errorReportTypes";
import type { AppPaths } from "../appPaths";
import { prepareErrorReportDraft } from "../errorReport";
import {
  type RegisteredRendererIpcContext,
  PRODUCTION_TRUSTED_IPC_RUNTIME,
  registeredRendererHandleContract,
  type TrustedIpcRuntime,
} from "./trustedIpc";

const CLIPBOARD_FALLBACK_BODY = [
  "The diagnostic report was copied to the clipboard because it was too long to prefill safely.",
  "",
  "Please paste the copied report here and review it before submitting this public issue.",
].join("\n");

export type ErrorReportIpcContext = RegisteredRendererIpcContext & {
  appPaths: AppPaths;
};

export type ErrorReportIpcRuntime = TrustedIpcRuntime & {
  prepareDraft: (
    context: ErrorReportContext,
    appPaths: AppPaths,
  ) => Promise<ErrorReportDraft>;
  writeClipboard: (text: string) => void;
  openExternal: (url: string) => Promise<void>;
  relaunch: () => void;
  exit: (code: number) => void;
  schedule: (callback: () => void, delayMs: number) => void;
};

const productionErrorReportIpcRuntime: ErrorReportIpcRuntime = {
  prepareDraft: prepareErrorReportDraft,
  writeClipboard: (text) => clipboard.writeText(text),
  openExternal: (url) => shell.openExternal(url),
  relaunch: () => app.relaunch(),
  exit: (code) => app.exit(code),
  schedule: (callback, delayMs) => {
    setTimeout(callback, delayMs);
  },
  ...PRODUCTION_TRUSTED_IPC_RUNTIME,
};

export function registerErrorReportIpc(
  context: ErrorReportIpcContext,
  runtime: ErrorReportIpcRuntime = productionErrorReportIpcRuntime,
): void {
  registeredRendererHandleContract(
    context,
    errorReportIpcContracts.prepareErrorReport,
    (_event, reportContext) =>
      runtime.prepareDraft(reportContext, context.appPaths),
    runtime,
  );

  registeredRendererHandleContract(
    context,
    errorReportIpcContracts.copyErrorReport,
    (_event, body) => {
      runtime.writeClipboard(body);
      return { copied: true };
    },
    runtime,
  );

  registeredRendererHandleContract(
    context,
    errorReportIpcContracts.openErrorReportIssue,
    async (_event, request) => openErrorReportIssue(request, runtime),
    runtime,
  );

  registeredRendererHandleContract(
    context,
    errorReportIpcContracts.restartApp,
    () => {
      runtime.relaunch();
      runtime.schedule(() => runtime.exit(0), 100);
      return { restarting: true };
    },
    runtime,
  );
}

export async function openErrorReportIssue(
  request: { title: string; body: string },
  runtime: Pick<
    ErrorReportIpcRuntime,
    "openExternal" | "writeClipboard"
  > = productionErrorReportIpcRuntime,
): Promise<OpenErrorReportIssueResult> {
  const prefilledUrl = buildGitHubIssueUrl(request.title, request.body);
  if (prefilledUrl.length <= ERROR_REPORT_GITHUB_URL_MAX_LENGTH) {
    await runtime.openExternal(prefilledUrl);
    return { opened: true, mode: "prefilled" };
  }

  runtime.writeClipboard(request.body);
  const fallbackUrl = buildGitHubIssueUrl(
    request.title,
    CLIPBOARD_FALLBACK_BODY,
  );
  await runtime.openExternal(fallbackUrl);
  return { opened: true, mode: "clipboard" };
}

export function buildGitHubIssueUrl(title: string, body: string): string {
  const url = new URL(
    title.trimStart().startsWith("[macOS Alpha]")
      ? APP_MAC_ALPHA_ISSUE_URL
      : APP_NEW_ISSUE_URL,
  );
  url.searchParams.set("title", title);
  url.searchParams.set("body", body);
  return url.toString();
}
