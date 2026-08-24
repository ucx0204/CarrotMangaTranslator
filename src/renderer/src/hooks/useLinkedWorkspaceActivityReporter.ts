import React from "react";
import type { LinkedWorkspaceActivityRequest } from "../../../shared/linkedWorkspaceTypes";
import { linkedWorkspaceGateway } from "../api/linkedWorkspaceGateway";

const REPORT_INTERVAL_MS = 120;
let hasReportedBridgeFailure = false;

function reportBridgeFailure(error: unknown): void {
  if (hasReportedBridgeFailure) return;
  hasReportedBridgeFailure = true;
  console.warn("연결 저장 활동 상태를 전달하지 못했습니다.", error);
}

export function useLinkedWorkspaceActivityReporter(
  chapterIds: readonly string[] | null,
): void {
  const chapterKey = React.useMemo(
    () => (chapterIds ? chapterIds.join("\u0000") : null),
    [chapterIds],
  );
  React.useEffect(() => {
    let active = chapterKey === null;
    let mounted = true;
    const reporter = createActivityReporter(() => active);
    const updateActive = (statuses: LinkedStatuses): void => {
      active = statuses.some(isActivitySensitiveConnection);
    };
    const ids = chapterKey ? chapterKey.split("\u0000") : [];
    if (ids.length > 0) {
      void linkedWorkspaceGateway
        .listLinkedWorkspaceStatuses(ids)
        .then((statuses) => mounted && updateActive(statuses))
        .catch((error: unknown) => {
          // If status discovery fails, reporting activity is the conservative
          // choice: it prevents background rendering from competing with edits.
          active = true;
          reportBridgeFailure(error);
        });
    }
    const unsubscribe =
      chapterKey === null
        ? () => undefined
        : linkedWorkspaceGateway.onLinkedWorkspaceStatusChanged(
            (event) => mounted && updateActive(event.statuses),
          );
    const removeListeners = installActivityListeners(reporter);
    return () => {
      mounted = false;
      unsubscribe();
      removeListeners();
      reporter.dispose();
    };
  }, [chapterKey]);
}

type LinkedStatuses = Awaited<
  ReturnType<typeof linkedWorkspaceGateway.listLinkedWorkspaceStatuses>
>;

function isActivitySensitiveConnection(
  status: LinkedStatuses[number],
): boolean {
  return (
    Boolean(status.connectionId) &&
    !["disabled", "unlinked"].includes(status.state)
  );
}

function createActivityReporter(isEnabled: () => boolean) {
  let lastPulseAt = 0;
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;
  const send = (request: LinkedWorkspaceActivityRequest): void => {
    if (!isEnabled()) return;
    void linkedWorkspaceGateway
      .reportLinkedWorkspaceActivity(request)
      .catch(reportBridgeFailure);
  };
  const pulse = (): void => {
    if (!isEnabled()) return;
    const remaining = REPORT_INTERVAL_MS - (performance.now() - lastPulseAt);
    if (remaining > 0) {
      trailingTimer ??= setTimeout(() => {
        trailingTimer = null;
        pulse();
      }, remaining);
      return;
    }
    lastPulseAt = performance.now();
    send({ type: "pulse" });
  };
  return {
    pulse,
    pointerStart: () => send({ type: "start", interaction: "pointer" }),
    pointerEnd: () => send({ type: "end", interaction: "pointer" }),
    compositionStart: () => send({ type: "start", interaction: "composition" }),
    compositionEnd: () => send({ type: "end", interaction: "composition" }),
    dispose: () => {
      if (trailingTimer) clearTimeout(trailingTimer);
      void linkedWorkspaceGateway
        .reportLinkedWorkspaceActivity({ type: "end", interaction: "pointer" })
        .catch(reportBridgeFailure);
      void linkedWorkspaceGateway
        .reportLinkedWorkspaceActivity({
          type: "end",
          interaction: "composition",
        })
        .catch(reportBridgeFailure);
    },
  };
}

type ActivityReporter = ReturnType<typeof createActivityReporter>;

function installActivityListeners(reporter: ActivityReporter): () => void {
  const passive = { capture: true, passive: true } as const;
  window.addEventListener("pointerdown", reporter.pointerStart, passive);
  window.addEventListener("pointerup", reporter.pointerEnd, passive);
  window.addEventListener("pointercancel", reporter.pointerEnd, passive);
  window.addEventListener("wheel", reporter.pulse, passive);
  window.addEventListener("keydown", reporter.pulse, true);
  window.addEventListener("input", reporter.pulse, true);
  window.addEventListener("compositionstart", reporter.compositionStart, true);
  window.addEventListener("compositionend", reporter.compositionEnd, true);
  window.addEventListener("blur", reporter.pointerEnd);
  window.addEventListener("blur", reporter.compositionEnd);
  return () => {
    window.removeEventListener("pointerdown", reporter.pointerStart, true);
    window.removeEventListener("pointerup", reporter.pointerEnd, true);
    window.removeEventListener("pointercancel", reporter.pointerEnd, true);
    window.removeEventListener("wheel", reporter.pulse, true);
    window.removeEventListener("keydown", reporter.pulse, true);
    window.removeEventListener("input", reporter.pulse, true);
    window.removeEventListener(
      "compositionstart",
      reporter.compositionStart,
      true,
    );
    window.removeEventListener("compositionend", reporter.compositionEnd, true);
    window.removeEventListener("blur", reporter.pointerEnd);
    window.removeEventListener("blur", reporter.compositionEnd);
  };
}
