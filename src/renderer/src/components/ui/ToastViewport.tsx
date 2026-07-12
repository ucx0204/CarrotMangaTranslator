import React from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import {
  dismissToast,
  getToasts,
  subscribeToasts,
  type Toast,
} from "../../lib/toastStore";
import { CheckCircleIcon, CloseIcon, InfoIcon, WarnIcon } from "./icons";

function ToastGlyph({
  variant,
}: {
  variant: Toast["variant"];
}): React.JSX.Element {
  if (variant === "success") {
    return <CheckCircleIcon size={17} />;
  }
  if (variant === "error") {
    return <WarnIcon size={17} />;
  }
  if (variant === "warn") {
    return <WarnIcon size={17} />;
  }
  return <InfoIcon size={17} />;
}

function ToastCard({ toast }: { toast: Toast }): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className={`toast ${toast.variant}`} role="status">
      <span className="toast-icon">
        <ToastGlyph variant={toast.variant} />
      </span>
      <div className="toast-body">
        <span className="toast-message">{toast.message}</span>
        {toast.action ? (
          <button
            type="button"
            className="toast-action"
            onClick={() => {
              toast.action?.onClick();
              dismissToast(toast.id);
            }}
          >
            {toast.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        className="toast-close"
        aria-label={t("toast.close")}
        onClick={() => dismissToast(toast.id)}
      >
        <CloseIcon size={14} />
      </button>
    </div>
  );
}

export function ToastViewport(): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const toasts = React.useSyncExternalStore(
    subscribeToasts,
    getToasts,
    getToasts,
  );
  if (typeof document === "undefined") {
    return null;
  }
  return createPortal(
    <div
      className="toast-viewport"
      role="region"
      aria-label={t("toast.region")}
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>,
    document.body,
  );
}
