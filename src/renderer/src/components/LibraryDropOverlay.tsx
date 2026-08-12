import React from "react";
import { IconBan, IconPhoto } from "@tabler/icons-react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

export type LibraryDropOverlayProps = {
  active: boolean;
  blocked: boolean;
};

export function LibraryDropOverlay({
  active,
  blocked,
}: LibraryDropOverlayProps): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (!active || typeof document === "undefined") return null;

  return createPortal(
    <div
      className={`library-drop-overlay ${blocked ? "blocked" : "ready"}`}
      role="status"
      aria-live="polite"
    >
      <div className="library-drop-card">
        <span className="library-drop-icon" aria-hidden="true">
          {blocked ? <IconBan size={30} /> : <IconPhoto size={30} />}
        </span>
        <strong>
          {t(blocked ? "libraryDrop.blockedTitle" : "libraryDrop.readyTitle")}
        </strong>
        <span>
          {t(
            blocked
              ? "libraryDrop.blockedDescription"
              : "libraryDrop.readyDescription",
          )}
        </span>
      </div>
    </div>,
    document.body,
  );
}
