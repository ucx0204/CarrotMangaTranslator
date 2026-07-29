import React from "react";

type CircularBrushCursorProps = {
  className?: string;
  color: string;
  kind: "bubble-layout" | "retouch";
  style?: React.CSSProperties;
};

/** Shared screen-space brush cursor used by retouch and bubble sculpt tools. */
export function CircularBrushCursor({
  className = "",
  color,
  kind,
  style,
}: CircularBrushCursorProps): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={`retouch-cursor ${className}`.trim()}
      data-bubble-layout-brush-cursor={
        kind === "bubble-layout" ? "" : undefined
      }
      data-retouch-live-cursor={kind === "retouch" ? "" : undefined}
      style={
        {
          ...style,
          "--retouch-cursor-color": color,
        } as React.CSSProperties
      }
    >
      <span />
    </div>
  );
}
