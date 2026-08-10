import React from "react";
import { DragOverlay } from "@dnd-kit/core";
import { IconDotsVertical, IconPhotoOff } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { MangaPage } from "../../../../shared/libraryTypes";
import { libraryGateway as mangaGateway } from "../../api/libraryGateway";
import { IconButton } from "../ui/IconButton";
import { MenuSurface } from "../ui/MenuSurface";
import { usePopupController } from "../ui/usePopupController";
import { CloseIcon, RefreshIcon } from "../ui/icons";
import {
  resolvePageDisplayStatus,
  resolvePageStatusLabel,
  type PageStatusMode,
} from "./pageListStatus";

export function PageListDragOverlay({
  activePage,
  selectedPageId,
  statusMode,
}: {
  activePage: MangaPage | null;
  selectedPageId: string | null;
  statusMode: PageStatusMode;
}): React.JSX.Element {
  return (
    <DragOverlay>
      {activePage ? (
        <PageDragPreview
          page={activePage}
          selected={activePage.id === selectedPageId}
          statusMode={statusMode}
        />
      ) : null}
    </DragOverlay>
  );
}

export function PageItemMenu({
  disabled,
  onRemove,
  onRetranslate,
  pageName,
}: {
  disabled: boolean;
  onRemove: () => void;
  onRetranslate: () => void;
  pageName: string;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const [open, setOpen] = React.useState(false);
  const { close, contentRef, rootRef, toggle, triggerRef } = usePopupController(
    {
      initialFocus: '[role="menuitem"]:not(:disabled)',
      open,
      onOpenChange: setOpen,
    },
  );
  const runAction = (action: () => void): void => {
    action();
    close(false);
  };
  return (
    <div className="page-actions" ref={rootRef}>
      <IconButton
        ref={triggerRef}
        size="sm"
        label={t("pageList.moreActions", { name: pageName })}
        title={t("pageList.more")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <IconDotsVertical size={16} aria-hidden="true" />
      </IconButton>
      {open ? (
        <MenuSurface
          ref={contentRef}
          className="page-actions-menu"
          ariaLabel={t("pageList.actionsLabel", { name: pageName })}
          onClose={close}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => runAction(onRetranslate)}
            disabled={disabled}
          >
            <RefreshIcon size={15} />
            <span>{t("pageList.retranslate")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => runAction(onRemove)}
            disabled={disabled}
          >
            <CloseIcon size={15} />
            <span>{t("common.delete")}</span>
          </button>
        </MenuSurface>
      ) : null}
    </div>
  );
}

function PageDragPreview({
  page,
  selected,
  statusMode,
}: {
  page: MangaPage;
  selected: boolean;
  statusMode: PageStatusMode;
}): React.JSX.Element {
  return (
    <div
      className={`page-item sortable-item drag-preview ${selected ? "active" : ""}`}
    >
      <span className="drag-handle compact preview-handle">
        <span className="drag-grip" aria-hidden="true" />
      </span>
      <div className="page-select preview-select" title={page.name}>
        <span className="page-thumbnail placeholder" aria-hidden="true" />
        <span className="page-row-copy">
          <strong>{page.name}</strong>
          <span className="page-row-meta">
            <PageStatus page={page} statusMode={statusMode} />
          </span>
        </span>
      </div>
    </div>
  );
}

export function PageStatus({
  page,
  statusMode,
  locked = false,
}: {
  page: MangaPage;
  statusMode: PageStatusMode;
  locked?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const status = locked
    ? "running"
    : resolvePageDisplayStatus(page, statusMode);
  return (
    <span className={`page-row-status ${status}`}>
      <span className="page-row-status-dot" aria-hidden="true" />
      {locked
        ? t("status.editLocked")
        : resolvePageStatusLabel(page, statusMode, t)}
    </span>
  );
}

type PageThumbnailState =
  | { status: "loading" }
  | { status: "loaded"; url: string }
  | { status: "error" };

export function PageListThumbnail({
  page,
}: {
  page: MangaPage;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const { frameRef, state } = usePageThumbnail(page);
  return (
    <span ref={frameRef} className="page-thumbnail" data-state={state.status}>
      {state.status === "loaded" ? (
        <img src={state.url} alt="" draggable={false} />
      ) : state.status === "error" ? (
        <IconPhotoOff
          size={18}
          aria-label={t("pageList.thumbnailLoadFailed")}
        />
      ) : (
        <span className="page-thumbnail-skeleton" aria-hidden="true" />
      )}
    </span>
  );
}

function usePageThumbnail(page: MangaPage): {
  frameRef: React.RefObject<HTMLSpanElement | null>;
  state: PageThumbnailState;
} {
  const frameRef = React.useRef<HTMLSpanElement | null>(null);
  const [state, setState] = React.useState<PageThumbnailState>(() =>
    page.dataUrl
      ? { status: "loaded", url: page.dataUrl }
      : { status: "loading" },
  );
  React.useEffect(() => {
    if (page.dataUrl) {
      setState({ status: "loaded", url: page.dataUrl });
      return;
    }
    let cancelled = false;
    let requested = false;
    const load = (): void => {
      if (requested) return;
      requested = true;
      setState({ status: "loading" });
      requestPageThumbnail(
        page.imagePath,
        (url) => !cancelled && setState({ status: "loaded", url }),
        () => !cancelled && setState({ status: "error" }),
      );
    };
    const observer = observeThumbnail(frameRef.current, load);
    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, [page.dataUrl, page.imagePath]);
  return { frameRef, state };
}

function observeThumbnail(
  frame: HTMLSpanElement | null,
  load: () => void,
): IntersectionObserver | null {
  if (!frame || typeof IntersectionObserver === "undefined") {
    load();
    return null;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        load();
        observer.disconnect();
      }
    },
    { root: frame.closest(".page-list-scroll"), rootMargin: "120px" },
  );
  observer.observe(frame);
  return observer;
}

function requestPageThumbnail(
  imagePath: string,
  onLoad: (url: string) => void,
  onError: () => void,
): void {
  let request: Promise<string>;
  try {
    request = mangaGateway.getPageImageDataUrl(imagePath);
  } catch (_expectedMissingBridge) {
    onError();
    return;
  }
  void request.then(onLoad).catch(onError);
}
