import React from "react";
import {
  IconDotsVertical,
  IconFolderOpen,
  IconFolderSymlink,
  IconRestore,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_RASTER_EXPORT_SETTINGS,
  type LinkedWorkspaceStatus,
} from "../../../../shared/linkedWorkspaceTypes";
import { linkedWorkspaceGateway } from "../../api/linkedWorkspaceGateway";
import { CheckboxField } from "../ui/CheckboxField";
import { IconButton } from "../ui/IconButton";
import { MenuSurface } from "../ui/MenuSurface";
import { usePopupController } from "../ui/usePopupController";

export function LinkedWorkspaceChapterRow({
  busy,
  chapterId,
  chapterTitle,
  error,
  onRun,
  status,
  workId,
}: {
  busy: boolean;
  chapterId: string;
  chapterTitle: string;
  error?: string;
  onRun: (
    chapterId: string,
    operation: () => Promise<unknown>,
  ) => Promise<void>;
  status: LinkedWorkspaceStatus | null;
  workId: string;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const connectionId = status?.connectionId;
  const enabled = Boolean(connectionId) && status?.state !== "disabled";
  const toggle = (checked: boolean): void => {
    void onRun(chapterId, () =>
      updateChapterConnection({ checked, chapterId, connectionId, workId }),
    );
  };
  return (
    <div className="linked-workspace-chapter-item">
      <div className="linked-workspace-chapter-row">
        <CheckboxField
          ariaLabel={t("settings.results.toggleChapter", {
            title: chapterTitle,
          })}
          checked={enabled}
          disabled={busy}
          onCheckedChange={toggle}
        />
        <div className="linked-workspace-chapter-copy">
          <strong>{chapterTitle}</strong>
          <span title={status?.rootPath ?? undefined}>
            {formatDestination(status, t)}
          </span>
        </div>
        <span
          className={`linked-workspace-status-badge ${status?.state ?? "unlinked"}`}
          title={status?.lastError}
        >
          {formatStatus(status, t)}
        </span>
        <ChapterConnectionActions
          busy={busy}
          chapterId={chapterId}
          onRun={onRun}
          status={status}
        />
      </div>
      <ChapterRowError error={error} />
    </div>
  );
}

function ChapterConnectionActions({
  busy,
  chapterId,
  onRun,
  status,
}: {
  busy: boolean;
  chapterId: string;
  onRun: (
    chapterId: string,
    operation: () => Promise<unknown>,
  ) => Promise<void>;
  status: LinkedWorkspaceStatus | null;
}): React.JSX.Element | null {
  if (!status?.connectionId) return null;
  return (
    <ConnectionActions
      busy={busy}
      chapterId={chapterId}
      connectionId={status.connectionId}
      destinationKind={status.destinationKind ?? "managed"}
      onRun={onRun}
    />
  );
}

function ChapterRowError({
  error,
}: {
  error?: string;
}): React.JSX.Element | null {
  return error ? (
    <p className="linked-workspace-row-error" role="alert">
      {error}
    </p>
  ) : null;
}

function ConnectionActions({
  busy,
  chapterId,
  connectionId,
  destinationKind,
  onRun,
}: {
  busy: boolean;
  chapterId: string;
  connectionId: string;
  destinationKind: LinkedWorkspaceStatus["destinationKind"];
  onRun: (
    chapterId: string,
    operation: () => Promise<unknown>,
  ) => Promise<void>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const [open, setOpen] = React.useState(false);
  const { close, contentRef, rootRef, toggle, triggerRef } = usePopupController(
    {
      disabled: busy,
      initialFocus: '[role="menuitem"]:not(:disabled)',
      open,
      onOpenChange: setOpen,
    },
  );
  const run = (operation: () => Promise<unknown>): void => {
    close(true);
    void onRun(chapterId, operation);
  };
  const label = t("settings.results.moreActions");
  return (
    <div className="linked-workspace-row-actions" ref={rootRef}>
      <IconButton
        ref={triggerRef}
        label={label}
        size="sm"
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={busy}
        onClick={toggle}
      >
        <IconDotsVertical size={17} stroke={2.1} aria-hidden="true" />
      </IconButton>
      {open && !busy ? (
        <ConnectionActionsMenu
          chapterId={chapterId}
          connectionId={connectionId}
          destinationKind={destinationKind}
          label={label}
          menuRef={contentRef}
          onClose={close}
          onRun={run}
        />
      ) : null}
    </div>
  );
}

function ConnectionActionsMenu({
  chapterId,
  connectionId,
  destinationKind,
  label,
  menuRef,
  onClose,
  onRun,
}: {
  chapterId: string;
  connectionId: string;
  destinationKind: LinkedWorkspaceStatus["destinationKind"];
  label: string;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onClose: (restoreFocus?: boolean) => void;
  onRun: (operation: () => Promise<unknown>) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <MenuSurface
      ref={menuRef}
      ariaLabel={label}
      className="linked-workspace-actions-menu"
      onClose={onClose}
    >
      <button
        role="menuitem"
        type="button"
        onClick={() => onRun(() => viewChapterResults(chapterId))}
      >
        <IconFolderOpen size={17} stroke={2.1} aria-hidden="true" />
        <span>{t("settings.results.viewResults")}</span>
      </button>
      <button
        role="menuitem"
        type="button"
        onClick={() =>
          onRun(() =>
            linkedWorkspaceGateway.reconnectLinkedWorkspace(connectionId),
          )
        }
      >
        <IconFolderSymlink size={17} stroke={2.1} aria-hidden="true" />
        <span>{t("settings.results.changeLocation")}</span>
      </button>
      <ResetLocationMenuItem
        connectionId={connectionId}
        destinationKind={destinationKind}
        onRun={onRun}
      />
    </MenuSurface>
  );
}

function ResetLocationMenuItem({
  connectionId,
  destinationKind,
  onRun,
}: {
  connectionId: string;
  destinationKind: LinkedWorkspaceStatus["destinationKind"];
  onRun: (operation: () => Promise<unknown>) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (destinationKind !== "custom") return null;
  return (
    <button
      role="menuitem"
      type="button"
      onClick={() =>
        onRun(() =>
          linkedWorkspaceGateway.resetLinkedWorkspaceLocation(connectionId),
        )
      }
    >
      <IconRestore size={17} stroke={2.1} aria-hidden="true" />
      <span>{t("settings.results.resetLocation")}</span>
    </button>
  );
}

async function updateChapterConnection({
  checked,
  chapterId,
  connectionId,
  workId,
}: {
  checked: boolean;
  chapterId: string;
  connectionId?: string;
  workId: string;
}): Promise<unknown> {
  if (connectionId) {
    return linkedWorkspaceGateway.updateLinkedWorkspace({
      connectionId,
      enabled: checked,
    });
  }
  if (!checked) return null;
  return linkedWorkspaceGateway.connectLinkedWorkspace({
    workId,
    chapterId,
    output: {
      ...DEFAULT_RASTER_EXPORT_SETTINGS,
      destinationMode: "fixed",
    },
  });
}

async function viewChapterResults(chapterId: string): Promise<void> {
  const result = await linkedWorkspaceGateway.viewLinkedResults({ chapterId });
  if (result.status === "failed") throw new Error(result.message);
}

function formatDestination(
  status: LinkedWorkspaceStatus | null,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (!status?.connectionId) return t("settings.results.defaultLocationReady");
  const label =
    status.destinationKind === "custom"
      ? t("settings.results.customLocation")
      : t("settings.results.defaultLocation");
  return status.rootPath ? `${label} · ${status.rootPath}` : label;
}

function formatStatus(
  status: LinkedWorkspaceStatus | null,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (!status || status.state === "unlinked")
    return t("settings.results.unlinked");
  if (status.state === "disabled") return t("settings.results.disabled");
  if (status.state === "syncing") return t("settings.results.syncing");
  if (status.state === "pending") {
    return t("settings.results.pending", { count: status.pendingCount });
  }
  if (status.state === "failed") return t("settings.results.failed");
  return t("settings.results.synced");
}
