import React from "react";
import { IconChevronDown } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { ReviewExportFormat } from "../../../../shared/reviewTypes";
import type { GatherTextSearch } from "../../hooks/useGatherTextSearch";
import { Button } from "../ui/Button";
import { ModalActionBar } from "../ui/ModalActionBar";

type GatherTextFooterProps = {
  excludeHeaders: boolean;
  onToggleExcludeHeaders: (value: boolean) => void;
  hasContent: boolean;
  hasChapter: boolean;
  canImportTxt: boolean;
  reviewBusy: boolean;
  onSave: () => void;
  onCopy: () => void;
  onExportReview: (format: ReviewExportFormat) => void;
  onImportReview: () => void;
  onImportTxt: () => void;
};

export function GatherTextFooter({
  excludeHeaders,
  onToggleExcludeHeaders,
  hasContent,
  hasChapter,
  canImportTxt,
  reviewBusy,
  onSave,
  onCopy,
  onExportReview,
  onImportReview,
  onImportTxt,
}: GatherTextFooterProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <ModalActionBar
      className="gather-text-footer"
      leading={
        <label className="inline-toggle">
          <input
            type="checkbox"
            checked={excludeHeaders}
            onChange={(event) => onToggleExcludeHeaders(event.target.checked)}
          />
          {t("gatherText.excludePageHeaders")}
        </label>
      }
      actions={
        <>
          <GatherTextExchangeMenu
            hasContent={hasContent}
            hasChapter={hasChapter}
            canImportTxt={canImportTxt}
            reviewBusy={reviewBusy}
            onSave={onSave}
            onExportReview={onExportReview}
            onImportReview={onImportReview}
            onImportTxt={onImportTxt}
          />
          <Button variant="primary" onClick={onCopy} disabled={!hasContent}>
            {t("common.copy")}
          </Button>
        </>
      }
    />
  );
}

export function GatherTextSearchBar({
  search,
}: {
  search: GatherTextSearch;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="gather-text-search-bar" role="search">
      <label htmlFor="gather-text-search-input">
        {t("gatherText.searchLabel")}
      </label>
      <div className="gather-text-search">
        <input
          id="gather-text-search-input"
          type="search"
          value={search.query}
          placeholder={t("gatherText.searchPlaceholder")}
          onChange={(event) => search.setQuery(event.target.value)}
          onKeyDown={search.handleKeyDown}
        />
        {search.query ? (
          <span className="gather-text-search-count" aria-live="polite">
            {Math.min(search.activeIndex + 1, search.matchCount)}/
            {search.matchCount}
          </span>
        ) : null}
      </div>
    </div>
  );
}

type GatherTextExchangeMenuProps = Pick<
  GatherTextFooterProps,
  | "hasContent"
  | "hasChapter"
  | "canImportTxt"
  | "reviewBusy"
  | "onSave"
  | "onExportReview"
  | "onImportReview"
  | "onImportTxt"
>;

function GatherTextExchangeMenu({
  hasContent,
  hasChapter,
  canImportTxt,
  reviewBusy,
  onSave,
  onExportReview,
  onImportReview,
  onImportTxt,
}: GatherTextExchangeMenuProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const { close, menuRef, open, rootRef, setOpen, triggerRef } =
    useGatherTextExchangeMenu();
  return (
    <div className="gather-text-exchange" ref={rootRef}>
      <Button
        ref={triggerRef}
        aria-haspopup="menu"
        aria-expanded={open}
        iconRight={<IconChevronDown size={15} aria-hidden="true" />}
        onClick={() => setOpen((current) => !current)}
      >
        {t("gatherText.exchangeMenu")}
      </Button>
      {open ? (
        <GatherTextExchangeMenuItems
          canImportTxt={canImportTxt}
          hasChapter={hasChapter}
          hasContent={hasContent}
          menuRef={menuRef}
          reviewBusy={reviewBusy}
          onClose={close}
          onExportReview={onExportReview}
          onImportReview={onImportReview}
          onImportTxt={onImportTxt}
          onSave={onSave}
        />
      ) : null}
    </div>
  );
}

function useGatherTextExchangeMenu() {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const close = React.useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);
  React.useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")
      ?.focus();
    const handlePointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [close, open]);
  return { close, menuRef, open, rootRef, setOpen, triggerRef };
}

type ExchangeMenuAction = {
  id: string;
  label: string;
  disabled: boolean;
  run: () => void;
  title?: string;
};

function GatherTextExchangeMenuItems({
  menuRef,
  onClose,
  ...props
}: Omit<GatherTextExchangeMenuProps, never> & {
  menuRef: React.RefObject<HTMLDivElement | null>;
  onClose: (restoreFocus?: boolean) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const reviewDisabled = !props.hasChapter || props.reviewBusy;
  const actions: ExchangeMenuAction[] = [
    {
      id: "save",
      label: t("gatherText.saveTxt"),
      disabled: !props.hasContent,
      run: props.onSave,
    },
    {
      id: "import-txt",
      label: t("gatherText.importTxt.button"),
      title: t("gatherText.importTxt.title"),
      disabled: !props.hasChapter || !props.canImportTxt,
      run: props.onImportTxt,
    },
    {
      id: "export-csv",
      label: t("gatherText.review.exportCsv"),
      disabled: reviewDisabled,
      run: () => props.onExportReview("csv"),
    },
    {
      id: "export-tsv",
      label: t("gatherText.review.exportTsv"),
      disabled: reviewDisabled,
      run: () => props.onExportReview("tsv"),
    },
    {
      id: "import-review",
      label: t("gatherText.review.import"),
      disabled: reviewDisabled,
      run: props.onImportReview,
    },
  ];
  return (
    <div
      ref={menuRef}
      className="gather-text-exchange-menu"
      role="menu"
      aria-label={t("gatherText.exchangeMenu")}
      onKeyDown={(event) => handleExchangeMenuKeyDown(event, onClose)}
    >
      {actions.map((action, index) => (
        <React.Fragment key={action.id}>
          {index === 2 ? (
            <span className="gather-text-menu-separator" role="separator" />
          ) : null}
          <button
            type="button"
            role="menuitem"
            disabled={action.disabled}
            title={action.title}
            onClick={() => {
              action.run();
              onClose(false);
            }}
          >
            {action.label}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}

function handleExchangeMenuKeyDown(
  event: React.KeyboardEvent<HTMLDivElement>,
  close: (restoreFocus?: boolean) => void,
): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  close(true);
}
