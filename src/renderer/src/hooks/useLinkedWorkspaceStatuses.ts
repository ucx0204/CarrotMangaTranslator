import React from "react";
import type { LinkedWorkspaceStatus } from "../../../shared/linkedWorkspaceTypes";
import { linkedWorkspaceGateway } from "../api/linkedWorkspaceGateway";

export function useLinkedWorkspaceStatuses(chapterIds: readonly string[]): {
  loading: boolean;
  statuses: ReadonlyMap<string, LinkedWorkspaceStatus>;
  refresh: () => Promise<void>;
} {
  const key = chapterIds.join("\u0000");
  const [loading, setLoading] = React.useState(true);
  const [statuses, setStatuses] = React.useState<
    ReadonlyMap<string, LinkedWorkspaceStatus>
  >(() => new Map());
  const refresh = React.useCallback(async (): Promise<void> => {
    const ids = key ? key.split("\u0000") : [];
    if (ids.length === 0) {
      setStatuses(new Map());
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const resolved =
        await linkedWorkspaceGateway.listLinkedWorkspaceStatuses(ids);
      setStatuses(
        new Map((resolved ?? []).map((status) => [status.chapterId, status])),
      );
    } finally {
      setLoading(false);
    }
  }, [key]);
  React.useEffect(() => {
    void refresh();
    return linkedWorkspaceGateway.onLinkedWorkspaceStatusChanged((event) => {
      const relevant = new Set(key ? key.split("\u0000") : []);
      setStatuses((current) => {
        const next = new Map(current);
        for (const status of event.statuses ?? []) {
          if (relevant.has(status.chapterId))
            next.set(status.chapterId, status);
        }
        return next;
      });
    });
  }, [key, refresh]);
  return { loading, statuses, refresh };
}
