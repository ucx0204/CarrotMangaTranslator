import React from "react";
import type { ImageRedactionStroke } from "../../../../shared/imageRedaction";
import { useEventCallback } from "../../hooks/useEventCallback";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";

type Options = {
  form: RedactionWorkspaceController;
  pageId: string;
  url: string;
  error: unknown;
  strokes: ImageRedactionStroke[];
  onReady?: (ready: boolean) => void;
  source: "detail" | "thumbnail";
};
/** Bind readiness to the displayed URL and exact committed mask, not to a previous page. */
export function useRedactionImageReadiness(options: Options) {
  const [decodedUrl, setDecodedUrl] = React.useState("");
  const [mask, setMask] = React.useState<ImageRedactionStroke[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const ready =
    Boolean(options.url) &&
    decodedUrl === options.url &&
    mask === options.strokes &&
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
    decoded: () => setDecodedUrl(options.url),
    masked: () => setMask(options.strokes),
    reject: (error?: unknown) => {
      setFailed(true);
      if (error) options.form.report(error);
    },
    retry: () => {
      setFailed(false);
      setDecodedUrl("");
      setMask(null);
    },
  };
}
