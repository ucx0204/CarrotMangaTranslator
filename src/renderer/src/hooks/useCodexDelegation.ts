import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "../../../shared/settingsTypes";
import { canUseCodexTypesetting } from "../../../shared/codexCapabilities";
import { useCodexConnection } from "./useCodexConnection";
import { codexConnection } from "../api/codexConnection";
import { analysisGateway } from "../api/analysisGateway";
import { toast } from "../lib/toastStore";

export function useCodexDelegation(settings: AppSettings | null) {
  const { t } = useTranslation("renderer");
  const { account, revision } = useCodexConnection(
    settings?.modelProvider === "openai-codex",
  );
  const latest = useRef({ settings });
  useEffect(() => {
    latest.current = { settings };
  }, [settings]);
  const wasConnected = useRef(false);
  const activeJob = useRef<string | null>(null);
  useEffect(() => {
    const connected = account?.authenticated === true;
    const lost = wasConnected.current && !connected;
    wasConnected.current = connected;
    if (lost && latest.current.settings?.modelProvider === "openai-codex")
      toast.error(t("codexDelegation.disconnected"));
    if (lost) cancelDisconnectedJob(activeJob.current);
  }, [account, revision, settings?.codex.delegateAll, t]);
  useCodexJobWatch(
    latest,
    activeJob,
    settings?.modelProvider === "openai-codex",
  );
  return (
    canUseCodexTypesetting(settings, account) &&
    settings?.codex.delegateAll === true
  );
}

function useCodexJobWatch(
  latest: { current: { settings: AppSettings | null } },
  activeJob: { current: string | null },
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return;
    return analysisGateway.onJobEvent((event) => {
      if (
        ["gemma-analysis", "sound-effect-translation", "inpainting"].includes(
          event.kind,
        ) &&
        ["starting", "running"].includes(event.status) &&
        latest.current.settings?.modelProvider === "openai-codex"
      )
        activeJob.current = event.id;
      if (
        ["completed", "partial", "failed", "cancelled"].includes(
          event.status,
        ) &&
        event.id === activeJob.current
      )
        activeJob.current = null;
      if (
        event.status !== "failed" ||
        latest.current.settings?.modelProvider !== "openai-codex"
      )
        return;
      void codexConnection.refresh().catch((error: unknown) => {
        console.error("Codex connection check failed", error);
        codexConnection.publish(null);
      });
    });
  }, [latest, activeJob, enabled]);
}

function cancelDisconnectedJob(jobId: string | null): void {
  if (!jobId) return;
  void analysisGateway
    .cancelJob({ reason: "codex-disconnected", jobId })
    .catch((error: unknown) =>
      console.error("Codex cancellation failed", error),
    );
}
