import React from "react";
import { useTranslation } from "react-i18next";
import type {
  ErrorReportContext,
  ErrorReportDraft,
} from "../../../shared/errorReportTypes";
import { errorReportGateway } from "../lib/errorReportGateway";

export type ReportAction = "copy" | "github" | "logs" | "restart";

type ActionFeedback = {
  kind: "error" | "success";
  message: string;
};

type ReportDraftState = {
  draft: ErrorReportDraft | null;
  loadError: boolean;
  title: string;
  description: string;
  includeSystem: boolean;
  includeLogs: boolean;
  reportBody: string;
  retry: () => void;
  setTitle: React.Dispatch<React.SetStateAction<string>>;
  setDescription: React.Dispatch<React.SetStateAction<string>>;
  setIncludeSystem: React.Dispatch<React.SetStateAction<boolean>>;
  setIncludeLogs: React.Dispatch<React.SetStateAction<boolean>>;
};

type ReportActionState = {
  activeAction: ReportAction | null;
  feedback: ActionFeedback | null;
  handleCopy: () => void;
  handleOpenIssue: () => void;
  handleOpenLogs: () => void;
  handleRestart: () => void;
};

export type ErrorReportDialogModel = ReportActionState &
  Omit<ReportDraftState, "draft"> & {
    draftReady: boolean;
    canShare: boolean;
  };

export function useErrorReportDialogModel(
  context: ErrorReportContext,
  onRestart: (() => unknown | Promise<unknown>) | undefined,
): ErrorReportDialogModel {
  const draftState = useReportDraft(context);
  const actionState = useReportActions({
    body: draftState.reportBody,
    title: draftState.title,
    onRestart,
  });
  return {
    ...draftState,
    ...actionState,
    draftReady: draftState.draft !== null,
    canShare:
      draftState.draft !== null &&
      draftState.title.trim().length > 0 &&
      actionState.activeAction === null,
  };
}

function useReportDraft(context: ErrorReportContext): ReportDraftState {
  const { t } = useTranslation("components");
  const [draft, setDraft] = React.useState<ErrorReportDraft | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  const [retryVersion, setRetryVersion] = React.useState(0);
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [includeSystem, setIncludeSystem] = React.useState(true);
  const [includeLogs, setIncludeLogs] = React.useState(true);
  const stableContext = useStableReportContext(context);
  const contextKey = getContextKey(stableContext);

  React.useEffect(() => {
    setTitle("");
    setDescription("");
    setIncludeSystem(true);
    setIncludeLogs(true);
  }, [contextKey]);
  React.useEffect(() => {
    let active = true;
    setDraft(null);
    setLoadError(false);
    void errorReportGateway
      .prepareErrorReport(stableContext)
      .then((nextDraft) => {
        if (active) {
          setDraft(nextDraft);
          setTitle((currentTitle) => currentTitle || nextDraft.defaultTitle);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          console.error(error);
          setLoadError(true);
        }
      });
    return () => {
      active = false;
    };
  }, [retryVersion, stableContext]);

  const reportBody = React.useMemo(
    () =>
      draft
        ? buildReportBody({
            description,
            draft,
            includeLogs,
            includeSystem,
            descriptionHeading: t("errorReport.descriptionHeading"),
            noDescription: t("errorReport.noDescription"),
            redactionNotice: t("errorReport.redactionNotice", {
              count: draft.redactionCount,
            }),
            truncatedNotice: t("errorReport.truncatedNotice"),
          })
        : "",
    [description, draft, includeLogs, includeSystem, t],
  );

  return {
    draft,
    loadError,
    title,
    description,
    includeSystem,
    includeLogs,
    reportBody,
    retry: () => setRetryVersion((version) => version + 1),
    setTitle,
    setDescription,
    setIncludeSystem,
    setIncludeLogs,
  };
}

function useReportActions({
  body,
  title,
  onRestart,
}: {
  body: string;
  title: string;
  onRestart: (() => unknown | Promise<unknown>) | undefined;
}): ReportActionState {
  const { t } = useTranslation("components");
  const { activeAction, feedback, runAction } = useActionRunner();
  const handleCopy = (): void => {
    void runAction("copy", async () => {
      await errorReportGateway.copyErrorReport(body);
      return t("errorReport.copySuccess");
    });
  };
  const handleOpenIssue = (): void => {
    void runAction("github", async () => {
      const result = await errorReportGateway.openErrorReportIssue({
        title: title.trim(),
        body,
      });
      if (!result.opened) {
        throw new Error("GitHub issue page was not opened.");
      }
      return result.mode === "clipboard"
        ? t("errorReport.clipboardFallback")
        : t("errorReport.githubOpened");
    });
  };
  const handleOpenLogs = (): void => {
    void runAction("logs", async () => {
      await errorReportGateway.openLogFolder();
    });
  };
  const handleRestart = (): void => {
    if (onRestart) {
      void runAction("restart", async () => {
        await onRestart();
      });
    }
  };
  return {
    activeAction,
    feedback,
    handleCopy,
    handleOpenIssue,
    handleOpenLogs,
    handleRestart,
  };
}

function useActionRunner(): {
  activeAction: ReportAction | null;
  feedback: ActionFeedback | null;
  runAction: (
    action: ReportAction,
    operation: () => Promise<string | void>,
  ) => Promise<void>;
} {
  const { t } = useTranslation("components");
  const [activeAction, setActiveAction] = React.useState<ReportAction | null>(
    null,
  );
  const [feedback, setFeedback] = React.useState<ActionFeedback | null>(null);
  const actionLockRef = React.useRef(false);
  const runAction = React.useCallback(
    async (
      action: ReportAction,
      operation: () => Promise<string | void>,
    ): Promise<void> => {
      if (actionLockRef.current) {
        return;
      }
      actionLockRef.current = true;
      setActiveAction(action);
      setFeedback(null);
      try {
        const successMessage = await operation();
        if (successMessage) {
          setFeedback({ kind: "success", message: successMessage });
        }
      } catch (error) {
        console.error(error);
        setFeedback({
          kind: "error",
          message: t(`errorReport.actionErrors.${action}`),
        });
      } finally {
        actionLockRef.current = false;
        setActiveAction(null);
      }
    },
    [t],
  );
  return { activeAction, feedback, runAction };
}

function buildReportBody({
  description,
  draft,
  includeLogs,
  includeSystem,
  descriptionHeading,
  noDescription,
  redactionNotice,
  truncatedNotice,
}: {
  description: string;
  draft: ErrorReportDraft;
  includeLogs: boolean;
  includeSystem: boolean;
  descriptionHeading: string;
  noDescription: string;
  redactionNotice: string;
  truncatedNotice: string;
}): string {
  const sections = [
    `## ${descriptionHeading}\n\n${description.trim() || noDescription}`,
    draft.errorMarkdown.trim(),
    includeSystem ? draft.systemMarkdown.trim() : "",
    includeLogs ? draft.logsMarkdown.trim() : "",
    `> ${redactionNotice}${draft.truncated ? `\n>\n> ${truncatedNotice}` : ""}`,
  ];
  return sections.filter(Boolean).join("\n\n");
}

function useStableReportContext(
  context: ErrorReportContext,
): ErrorReportContext {
  return React.useMemo(
    () => ({
      source: context.source,
      summary: context.summary,
      message: context.message,
      stack: context.stack,
      componentStack: context.componentStack,
      jobStage: context.jobStage,
    }),
    [
      context.componentStack,
      context.jobStage,
      context.message,
      context.source,
      context.stack,
      context.summary,
    ],
  );
}

function getContextKey(context: ErrorReportContext): string {
  return JSON.stringify([
    context.source,
    context.summary,
    context.message,
    context.stack,
    context.componentStack,
    context.jobStage,
  ]);
}
