import { useEffect, useSyncExternalStore } from "react";
import { codexConnection } from "../api/codexConnection";

export function useCodexConnection(enabled: boolean) {
  const revision = useSyncExternalStore(
    codexConnection.subscribe,
    codexConnection.getRevision,
  );
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      if (document.hidden) return;
      void codexConnection.refresh().catch((error: unknown) => {
        console.error("Codex account refresh failed", error);
        codexConnection.publish(null);
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const interval = window.setInterval(refresh, 60_000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(interval);
    };
  }, [enabled]);
  return { account: codexConnection.getSnapshot(), revision };
}
