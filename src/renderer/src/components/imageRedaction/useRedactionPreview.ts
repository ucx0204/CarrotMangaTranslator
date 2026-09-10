import React from "react";
import type { RedactionPreviewCache } from "./redactionPreviewCache";

export function useRedactionPreview(cache: RedactionPreviewCache, sessionId: string, pageId: string, edge: 320 | 2048) {
  const [result, setResult] = React.useState<{ key: string; url: string; error: unknown }>({ key: "", url: "", error: null });
  const [attempt, setAttempt] = React.useState(0);
  const key = `${sessionId}:${pageId}:${edge}:${attempt}`;
  React.useEffect(() => {
    let active = true;
    void cache.read({ sessionId, pageId, maxEdge: edge }, edge === 2048).then(
      (url) => { if (active) setResult({ key, url, error: null }); },
      (error: unknown) => { if (active) setResult({ key, url: "", error }); },
    );
    return () => { active = false; };
  }, [cache, sessionId, pageId, edge, key]);
  return { url: result.key === key ? result.url : "", error: result.key === key ? result.error : null, retry: () => setAttempt((value) => value + 1) };
}
