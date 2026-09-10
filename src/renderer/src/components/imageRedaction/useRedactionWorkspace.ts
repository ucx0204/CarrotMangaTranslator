import React from "react";
import { useEventCallback } from "../../hooks/useEventCallback";
import { useTranslation } from "react-i18next";
import type { RedactionWorkspace } from "../../../../shared/imageRedactionWorkspace";
import { analysisGateway } from "../../api/analysisGateway";
import { useAsyncErrorState } from "../../hooks/useAsyncErrorState";
import {
  createRedactionSession,
  type RedactionSession,
} from "./redactionSession";
import {
  RedactionDraftWriter,
  type RedactionSaveStatus,
} from "./redactionDraftWriter";
import { RedactionPreviewCache } from "./redactionPreviewCache";

export type RedactionWorkspaceController = ReturnType<
  typeof useRedactionWorkspace
>;
export function useRedactionWorkspace(workspace: RedactionWorkspace) {
  const { t } = useTranslation("components");
  const [state, setState] = React.useState(() =>
    createRedactionSession(workspace),
  );
  const live = React.useRef(state);
  const mounted = React.useRef(true);
  const [saveStatus, setSaveStatus] = React.useState<RedactionSaveStatus>({
    kind: "saved",
  });
  const { error, setError, report } = useAsyncErrorState(
    t("manualRedaction.operationFailed"),
  );
  const { ready, failed, markPreview } = usePreviewStatus();
  const [busy, setBusy] = React.useState(false);
  const [drawing, setDrawing] = React.useState(false);
  const read = useEventCallback(() => live.current);
  const notify = useEventCallback((status: RedactionSaveStatus) => {
    if (!mounted.current) return;
    setSaveStatus(status);
    if (status.kind === "saved") setError("");
  });
  const [writer] = React.useState(
    () =>
      new RedactionDraftWriter(state, {
        read,
        notify,
        persist: (request) => analysisGateway.saveRedactionWorkspace(request),
      }),
  );
  const previews = useWorkspacePreviews(mounted);
  const commit = React.useCallback(
    (change: (current: RedactionSession) => RedactionSession) => {
      try {
        const next = change(live.current);
        if (next === live.current) return;
        live.current = next;
        setState(next);
      } catch (failure) {
        report(failure);
      }
    },
    [report],
  );
  React.useEffect(() => {
    const timer = setTimeout(() => {
      void writer.flush().catch(report);
    }, 250);
    return () => clearTimeout(timer);
  }, [state, writer, report]);

  return {
    state,
    live,
    commit,
    ready,
    failed,
    markPreview,
    previews,
    saveStatus,
    error,
    setError,
    report,
    busy,
    setBusy,
    drawing,
    setDrawing,
    flush: () => writer.flush(),
  };
}

function updateMembership(
  current: Set<string>,
  id: string,
  present: boolean,
): Set<string> {
  if (current.has(id) === present) return current;
  const next = new Set(current);
  if (present) next.add(id);
  else next.delete(id);
  return next;
}

function usePreviewStatus() {
  const [ready, setReady] = React.useState<Set<string>>(() => new Set());
  const [failures, setFailures] = React.useState<Record<string, string[]>>({});
  const failed = React.useMemo(
    () => new Set(Object.keys(failures)),
    [failures],
  );
  const markPreview = React.useCallback(
    (id: string, status: "ready" | "error", source = "prefetch") => {
      setReady((current) => updateMembership(current, id, status === "ready"));
      setFailures((current) => {
        const sources = new Set(current[id]);
        if (status === "error") sources.add(source);
        else {
          sources.delete(source);
          sources.delete("prefetch");
        }
        if ([...sources].join() === (current[id] ?? []).join()) return current;
        const next = { ...current };
        if (sources.size) next[id] = [...sources];
        else delete next[id];
        return next;
      });
    },
    [],
  );
  return { ready, failed, markPreview };
}

function useWorkspacePreviews(mounted: React.RefObject<boolean>) {
  const [previews] = React.useState(
    () =>
      new RedactionPreviewCache((request) =>
        analysisGateway.getRedactionWorkspacePreview(request),
      ),
  );
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (!mounted.current) previews.dispose();
      });
    };
  }, [previews, mounted]);
  return previews;
}
