import React from "react";
import { IconBell } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { JobState } from "../../../shared/jobTypes";
import { IconButton } from "./ui/IconButton";
import { StatusPopover } from "./StatusPopover";

export function StatusDockButton({
  jobState,
  statusLines,
  onClear,
}: {
  jobState: JobState;
  statusLines: string[];
  onClear: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const popoverId = React.useId();
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const previousLatestRef = React.useRef<string | undefined>(undefined);
  const [open, setOpen] = React.useState(false);
  const [unread, setUnread] = React.useState(false);
  const latest = statusLines[0];
  const closePopover = React.useCallback(() => setOpen(false), []);

  React.useEffect(() => {
    if (latest && latest !== previousLatestRef.current && !open) {
      setUnread(true);
    }
    previousLatestRef.current = latest;
  }, [latest, open]);
  React.useEffect(() => {
    if (open) setUnread(false);
  }, [open]);
  useStatusPopoverDismiss(open, rootRef, closePopover);

  const indicator = resolveStatusIndicator(jobState, unread);
  const tooltip = latest
    ? t("statusDock.latest", { line: latest })
    : t("statusDock.open");
  return (
    <div className="status-dock" ref={rootRef}>
      <IconButton
        className={`status-dock-button ${indicator}`}
        label={t("statusDock.open")}
        title={tooltip}
        aria-controls={popoverId}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <IconBell size={18} aria-hidden="true" />
        <span className="status-dock-indicator" aria-hidden="true" />
      </IconButton>
      {open ? (
        <StatusPopover
          id={popoverId}
          jobState={jobState}
          statusLines={statusLines}
          onClear={() => {
            onClear();
            setUnread(false);
          }}
          onClose={closePopover}
        />
      ) : null}
    </div>
  );
}

function resolveStatusIndicator(jobState: JobState, unread: boolean): string {
  if (jobState.status === "failed") return "failed";
  if (jobState.status === "partial") return "partial";
  if (
    jobState.status === "starting" ||
    jobState.status === "running" ||
    jobState.status === "cancelling"
  ) {
    return "running";
  }
  return unread ? "unread" : "idle";
}

function useStatusPopoverDismiss(
  open: boolean,
  rootRef: React.RefObject<HTMLDivElement | null>,
  close: () => void,
): void {
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open, rootRef]);
}
