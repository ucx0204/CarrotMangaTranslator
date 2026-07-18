import { app, clipboard, shell } from "electron";
import {
  APP_MAC_ALPHA_ISSUE_URL,
  APP_NEW_ISSUE_URL,
} from "../../shared/appRelease";
import { errorReportIpcContracts } from "../../shared/ipcContracts";
import {
  ERROR_REPORT_GITHUB_URL_MAX_LENGTH,
  type OpenErrorReportIssueResult,
} from "../../shared/errorReportTypes";
import { prepareErrorReportDraft } from "../errorReport";
import type { IpcContext } from "./context";
import { registeredRendererHandleContract } from "./trustedIpc";

const CLIPBOARD_FALLBACK_BODY = [
  "The diagnostic report was copied to the clipboard because it was too long to prefill safely.",
  "",
  "Please paste the copied report here and review it before submitting this public issue.",
].join("\n");

export function registerErrorReportIpc(context: IpcContext): void {
  registeredRendererHandleContract(
    context,
    errorReportIpcContracts.prepareErrorReport,
    (_event, reportContext) =>
      prepareErrorReportDraft(reportContext, context.appPaths),
  );

  registeredRendererHandleContract(
    context,
    errorReportIpcContracts.copyErrorReport,
    (_event, body) => {
      clipboard.writeText(body);
      return { copied: true };
    },
  );

  registeredRendererHandleContract(
    context,
    errorReportIpcContracts.openErrorReportIssue,
    async (_event, request) => openErrorReportIssue(request),
  );

  registeredRendererHandleContract(
    context,
    errorReportIpcContracts.restartApp,
    () => {
      app.relaunch();
      setTimeout(() => app.exit(0), 100);
      return { restarting: true };
    },
  );
}

export async function openErrorReportIssue(request: {
  title: string;
  body: string;
}): Promise<OpenErrorReportIssueResult> {
  const prefilledUrl = buildGitHubIssueUrl(request.title, request.body);
  if (prefilledUrl.length <= ERROR_REPORT_GITHUB_URL_MAX_LENGTH) {
    await shell.openExternal(prefilledUrl);
    return { opened: true, mode: "prefilled" };
  }

  clipboard.writeText(request.body);
  const fallbackUrl = buildGitHubIssueUrl(
    request.title,
    CLIPBOARD_FALLBACK_BODY,
  );
  await shell.openExternal(fallbackUrl);
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
