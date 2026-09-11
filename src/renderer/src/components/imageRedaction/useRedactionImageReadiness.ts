import React from "react";
import type { ImageRedactionStroke } from "../../../../shared/imageRedaction";
import { useEventCallback } from "../../hooks/useEventCallback";
import { formatErrorMessage } from "../../lib/errorPresentation";
import { useTranslation } from "react-i18next";
import type { RedactionWorkspaceController } from "./redactionWorkspaceTypes";

type Options = {
  form: Pick<RedactionWorkspaceController, "markPreview">;
  pageId: string;
  requestKey: string;
  url: string;
  error: unknown;
  strokes: ImageRedactionStroke[];
  onReady?: (ready: boolean) => void;
  source: "detail" | "thumbnail";
};
/** Bind readiness to the displayed URL and exact committed mask, not to a previous page. */
export function useRedactionImageReadiness(options: Options) {
  const { t } = useTranslation("components");
  const [decoded, setDecoded] = React.useState({ key: "", url: "" });
  const [mask, setMask] = React.useState<{
    key: string;
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
    masked: () => setMask({ key, strokes: options.strokes }),
    reject: (error?: unknown) => {
      setFailedKey(key);
      if (error) formatErrorMessage(error, t("manualRedaction.previewFailed"));
    },
  };
}
