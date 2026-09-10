import React from "react";
import { useTranslation } from "react-i18next";
import type { RedactionWorkspace } from "../../../../shared/imageRedactionWorkspace";
import { analysisGateway } from "../../api/analysisGateway";
import { formatErrorMessage } from "../../lib/errorPresentation";
import { createRedactionSession, type RedactionSession } from "./redactionSession";
import { RedactionDraftWriter, type RedactionSaveStatus } from "./redactionDraftWriter";
import { RedactionPreviewCache } from "./redactionPreviewCache";

export type RedactionWorkspaceController = ReturnType<typeof useRedactionWorkspace>;
export function useRedactionWorkspace(workspace: RedactionWorkspace) {
  const { t } = useTranslation("components");
  const [state, setState] = React.useState(() => createRedactionSession(workspace));
  const live = React.useRef(state);
  const mounted = React.useRef(true);
  const [saveStatus, setSaveStatus] = React.useState<RedactionSaveStatus>({ kind: "saved" });
  const [error, setError] = React.useState("");
  const [ready, setReady] = React.useState<Set<string>>(() => new Set());
  const [failed, setFailed] = React.useState<Set<string>>(() => new Set());
  const [busy, setBusy] = React.useState(false);
  const [drawing, setDrawing] = React.useState(false);
  const [writer] = React.useState(() => new RedactionDraftWriter(state, {
    read: () => live.current,
    persist: (request) => analysisGateway.saveRedactionWorkspace(request),
    notify: (status) => { if (mounted.current) setSaveStatus(status); },
  }));
  const [previews] = React.useState(() => new RedactionPreviewCache((request) => analysisGateway.getRedactionWorkspacePreview(request)));
  const report = React.useCallback((failure: unknown) => {
    const message = formatErrorMessage(failure, t("manualRedaction.operationFailed"));
    if (mounted.current) setError(message);
  }, [t]);
  const commit = React.useCallback((change: (current: RedactionSession) => RedactionSession) => {
    try {
      const next = change(live.current);
      if (next === live.current) return;
      live.current = next; setState(next);
    } catch (failure) { report(failure); }
  }, [report]);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; previews.dispose(); };
  }, [previews]);
  React.useEffect(() => {
    const timer = setTimeout(() => { void writer.flush().catch(report); }, 250);
    return () => clearTimeout(timer);
  }, [state, writer, report]);
  const markPreview = React.useCallback((id: string, status: "ready" | "error") => {
    setReady((current) => updateMembership(current, id, status === "ready"));
    setFailed((current) => updateMembership(current, id, status === "error"));
  }, []);
  return {
    state, live, commit, ready, failed, markPreview, previews, saveStatus,
    error, setError, report, busy, setBusy, drawing, setDrawing,
    flush: () => writer.flush(),
  };
}

function updateMembership(current: Set<string>, id: string, present: boolean): Set<string> {
  if (current.has(id) === present) return current;
  const next = new Set(current);
  if (present) next.add(id); else next.delete(id);
  return next;
}
