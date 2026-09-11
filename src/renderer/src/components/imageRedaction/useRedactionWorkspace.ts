import React from "react";
import { useEventCallback } from "../../hooks/useEventCallback";
import { useTranslation } from "react-i18next";
import type { RedactionWorkspace } from "../../../../shared/imageRedactionWorkspace";
import { analysisGateway } from "../../api/analysisGateway";
import { useAsyncErrorState } from "../../hooks/useAsyncErrorState";
import { createRedactionSession } from "./redactionSession";
import {
  RedactionDraftWriter,
  type RedactionSaveStatus,
} from "./redactionDraftWriter";
import { RedactionPreviewCache } from "./redactionPreviewCache";
import { runRedactionCommand, type RedactionCommand } from "./redactionCommand";

import type { RedactionWorkspaceController as WorkspaceController } from "./redactionWorkspaceTypes";

// Keep the hook's public type name while the feature contract owns its shape.
export type RedactionWorkspaceController = WorkspaceController;

export function useRedactionWorkspace(
  workspace: RedactionWorkspace,
): RedactionWorkspaceController {
  const { t } = useTranslation("components");
  const [state, setState] = React.useState(() =>
    createRedactionSession(workspace),
  );
  const live = React.useRef(state);
  const mounted = React.useRef(true);
  const [saveStatus, setSaveStatus] = React.useState<RedactionSaveStatus>({
    kind: "saved",
  });
  const {
    error: commandError,
    setError,
    report,
  } = useAsyncErrorState(t("manualRedaction.operationFailed"));
  const saveError = useAsyncErrorState(t("manualRedaction.save_error"));
  const { ready, failed, markPreview } = usePreviewStatus();
  const [busy, setBusy] = React.useState(false);
  const [drawing, setDrawing] = React.useState(false);
  const read = useEventCallback(() => live.current);
  const notify = useEventCallback((status: RedactionSaveStatus) => {
    if (!mounted.current) return;
    setSaveStatus(status);
    if (status.kind === "saved") saveError.setError("");
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
    (change: RedactionCommand) => {
      const result = runRedactionCommand(live.current, change);
      if (!result.ok) report(result.error);
      else if (result.state !== live.current) {
        live.current = result.state;
        setState(result.state);
      }
      return result;
    },
    [report],
  );
  const retrySave = useEventCallback(() => {
    // Background/retry failures belong to saving, not to the current command.
    void writer.flush().catch(saveError.report);
  });
  React.useEffect(() => {
    const timer = setTimeout(retrySave, 250);
    return () => clearTimeout(timer);
  }, [state, retrySave]);

  return {
    state,
    live,
    commit,
    ready,
    failed,
    markPreview,
    previews,
    dirty: writer.isDirty,
    saveStatus:
      writer.isDirty && saveStatus.kind === "saved"
        ? ({ kind: "saving" } as const)
        : saveStatus,
    error: commandError || saveError.error,
    setError,
    report,
    busy,
    setBusy,
    drawing,
    setDrawing,
    flush: () => writer.flush(),
    retrySave,
    pauseSaving: () => writer.pause(),
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
