import React from "react";
import type { RuntimeCapabilities } from "../../../shared/runtimeCapabilities";

export function MacAlphaBadge(): React.JSX.Element | null {
  const [capabilities, setCapabilities] =
    React.useState<RuntimeCapabilities | null>(null);

  React.useEffect(() => {
    let mounted = true;
    const getRuntimeCapabilities = window.mangaApi?.getRuntimeCapabilities;
    if (!getRuntimeCapabilities) {
      return () => {
        mounted = false;
      };
    }
    void getRuntimeCapabilities()
      .then((result) => {
        if (mounted) {
          setCapabilities(result);
        }
      })
      .catch(() => {
        if (mounted) {
          setCapabilities(null);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (capabilities?.buildChannel !== "mac-alpha") {
    return null;
  }
  const memoryLabel = capabilities.unifiedMemoryMb
    ? `${Math.round(capabilities.unifiedMemoryMb / 1024)} GB`
    : null;
  return (
    <div
      className="mac-alpha-badge"
      aria-label="Apple Silicon Alpha"
      title="Real-device validation in progress. Report problems through GitHub Issues."
    >
      <span className="mac-alpha-badge-dot" aria-hidden="true" />
      <strong>Apple Silicon Alpha</strong>
      {memoryLabel ? <span>{memoryLabel}</span> : null}
    </div>
  );
}
