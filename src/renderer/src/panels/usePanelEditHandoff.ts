import { useEffect, useRef, useState } from "react";
import type {
  PanelCommand,
  PanelSyncState,
} from "../../../shared/panelBridgeTypes";
import type { AppActivityState } from "../../../shared/appActivityTypes";
import { panelGateway } from "../api/panelGateway";
import { pendingPageEdits } from "../lib/pageEditBarrier";
import { useEventCallback } from "../hooks/useEventCallback";
import { usePageInputActivity } from "../hooks/usePageEditHandoff";

/** The acknowledgement follows all input and commands from the detached editor. */
export function usePanelEditHandoffHost(
  enabled: boolean,
  state: PanelSyncState,
) {
  const [requests, setRequests] = useState<
    NonNullable<PanelSyncState["editHandoff"]>[]
  >([]);
  const pending = useRef(new Map<string, (error?: string) => void>());
  const flush = useEventCallback(async (chapterId: string, pageId: string) => {
    if (
      state.editPage?.chapterId !== chapterId ||
      state.editPage.pageId !== pageId
    )
      return;
    const requestId = crypto.randomUUID();
    const finishInput = pendingPageEdits.begin(chapterId, pageId);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(
          () => finish("분리된 편집 창의 저장 응답을 기다리고 있습니다."),
          12000,
        );
        const finish = (error?: string) => {
          window.clearTimeout(timer);
          pending.current.delete(requestId);
          setRequests((current) =>
            current.filter((request) => request.requestId !== requestId),
          );
          if (error) reject(new Error(error));
          else resolve();
        };
        pending.current.set(requestId, finish);
        setRequests((current) => [
          ...current,
          { requestId, chapterId, pageId },
        ]);
      });
    } finally {
      finishInput();
    }
  });
  useEffect(() => {
    if (!enabled) return;
    const requestsToFinish = pending.current;
    const unregister = pendingPageEdits.registerFlusher(flush);
    return () => {
      unregister();
      for (const finish of requestsToFinish.values())
        finish(
          "편집 창이 닫혀 저장 완료를 확인하지 못했습니다. 다시 시도해 주세요.",
        );
    };
  }, [enabled, flush]);
  const acknowledge = useEventCallback((command: PanelCommand) => {
    if (command.type !== "finishPageEdits") return false;
    pending.current.get(command.requestId)?.(command.error);
    return true;
  });
  return {
    state: { ...state, ...(requests[0] ? { editHandoff: requests[0] } : {}) },
    acknowledge,
  };
}

export function useRemotePanelEditHandoff(
  state: PanelSyncState | null,
): boolean {
  const request = state?.editHandoff;
  const activity: AppActivityState = {
    version: 0,
    activities: [],
    pages: request
      ? [{ ...request, jobId: "panel-handoff", phase: "finishing-edits" }]
      : [],
  };
  const active = usePageInputActivity(
    state?.editPage?.chapterId,
    state?.editPage?.pageId ?? null,
    activity,
  );
  const handled = useRef(new Set<string>());
  useEffect(() => {
    if (!request || handled.current.has(request.requestId)) return;
    handled.current.add(request.requestId);
    void (async () => {
      let error: string | undefined;
      try {
        await pendingPageEdits.waitForIdle(request.chapterId, request.pageId);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      // IPC ordering ensures the main renderer sees preceding edit commands first.
      await panelGateway.sendPanelCommand({
        type: "finishPageEdits",
        requestId: request.requestId,
        ...(error ? { error } : {}),
      });
    })().catch((error) =>
      console.error("Could not finish detached editor input", error),
    );
  }, [request]);
  return Boolean(
    state?.editPage &&
    active.has(`${state.editPage.chapterId}/${state.editPage.pageId}`),
  );
}
