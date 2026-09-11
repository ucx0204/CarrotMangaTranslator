import React from "react";
import type { RedactionPreviewSource } from "./redactionWorkspaceTypes";

export function useRedactionPreview(
  cache: RedactionPreviewSource,
  sessionId: string,
  pageId: string,
  edge: 320 | 2048,
) {
  const [result, setResult] = React.useState<{
    key: string;
    url: string;
    error: unknown;
  }>({ key: "", url: "", error: null });
  const attempt = React.useSyncExternalStore(cache.subscribe, () =>
    cache.version(sessionId, pageId),
  );
  const key = `${sessionId}:${pageId}:${edge}:${attempt}`;
  React.useEffect(() => {
    let active = true;
    void cache.read({ sessionId, pageId, maxEdge: edge }, edge === 2048).then(
      (url) => {
        if (active) setResult({ key, url, error: null });
      },
      (error: unknown) => {
        if (active) setResult({ key, url: "", error });
      },
    );
    return () => {
      active = false;
    };
  }, [cache, sessionId, pageId, edge, key]);
  return {
    key,
    url: result.key === key ? result.url : "",
    error: result.key === key ? result.error : null,
    retry: () => cache.retryPage(sessionId, pageId),
  };
}
