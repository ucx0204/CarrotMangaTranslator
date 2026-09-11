import React from "react";
import type { ImageRedactionStroke } from "../../../../shared/imageRedaction";
import { useEventCallback } from "../../hooks/useEventCallback";
import type { RedactionWorkspaceController } from "./redactionWorkspaceTypes";

type Options = {
  form: Pick<RedactionWorkspaceController, "markPreview">;
  pageId: string;
  requestKey: string;
  url: string;
  error: unknown;
  strokes: ImageRedactionStroke[];
  renderKey?: unknown;
  onReady?: (ready: boolean) => void;
  source: "detail" | "thumbnail";
};
/** Bind readiness to the displayed URL and exact committed mask, not to a previous page. */
export function useRedactionImageReadiness(options: Options) {
  const [decoded, setDecoded] = React.useState({ key: "", url: "" });
  const [mask, setMask] = React.useState<{
    key: string;
    renderKey?: unknown;
    strokes: ImageRedactionStroke[] | null;
  }>({ key: "", strokes: null });
  const [failedKey, setFailedKey] = React.useState<string | null>(null);
  const key = options.requestKey;
  const failed = failedKey === key;
  const ready =
    Boolean(options.url) &&
    decoded.key === key &&
    decoded.url === options.url &&
    mask.key === key &&
    mask.strokes === options.strokes &&
    mask.renderKey === options.renderKey &&
    !failed &&
    !options.error;
  const notify = useEventCallback((value: boolean) => options.onReady?.(value));
  const { markPreview } = options.form;
  React.useEffect(() => {
    notify(ready);
    if (failed || options.error)
      markPreview(options.pageId, "error", options.source);
    else if (ready) markPreview(options.pageId, "ready", options.source);
    return () => notify(false);
  }, [
    ready,
    failed,
    options.error,
    options.pageId,
    options.source,
    notify,
    markPreview,
  ]);
  return {
    ready,
    failed,
    decoded: () => setDecoded({ key, url: options.url }),
    masked: () =>
      setMask({ key, strokes: options.strokes, renderKey: options.renderKey }),
    reject: (error?: unknown) => {
      setFailedKey(key);
      // Raw diagnostics stay out of view state; the view owns the localized notice.
      if (error) console.error("Redaction preview failed", error);
    },
  };
}
