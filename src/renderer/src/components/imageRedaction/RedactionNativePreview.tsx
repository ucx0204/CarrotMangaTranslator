import React from "react";
import { useEventCallback } from "../../hooks/useEventCallback";
import { renderNativeRedactionPreview } from "./redactionNativeSurface";
import type { RedactionPreviewSource } from "./redactionWorkspaceTypes";
import type { RedactionMaskWindow } from "./redactionMaskWindow";
import styles from "./RedactionWorkspace.module.css";

type Props = {
  cache: RedactionPreviewSource;
  sessionId: string;
  page: { id: string; width: number; height: number };
  window: RedactionMaskWindow;
  onReady: () => void;
  onFailure: (error: unknown) => void;
};
export function RedactionNativePreview(props: Props): React.JSX.Element {
  const { cache, sessionId, page, window } = props;
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const ready = useEventCallback(props.onReady);
  const fail = useEventCallback(props.onFailure);
  React.useEffect(() => {
    const controller = new AbortController();
    void renderNativeRedactionPreview(
      cache,
      sessionId,
      page.id,
      window,
      controller.signal,
    )
      .then((image) => {
        if (controller.signal.aborted || !canvas.current) return;
        const target = canvas.current;
        target.width = image.width;
        target.height = image.height;
        const context = target.getContext("2d");
        if (!context)
          throw new Error("The native preview canvas is unavailable");
        context.drawImage(image, 0, 0);
        ready();
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) fail(error);
      });
    return () => controller.abort();
  }, [cache, sessionId, page.id, window, ready, fail]);
  return (
    <canvas
      ref={canvas}
      aria-hidden="true"
      className={styles.maskCanvas}
      style={{
        left: `${(100 * window.x) / page.width}%`,
        top: `${(100 * window.y) / page.height}%`,
        width: `${(100 * window.width) / page.width}%`,
        height: `${(100 * window.height) / page.height}%`,
        right: "auto",
        bottom: "auto",
      }}
    />
  );
}
