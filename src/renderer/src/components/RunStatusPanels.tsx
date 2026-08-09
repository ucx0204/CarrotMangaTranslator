import React from "react";
import { useTranslation } from "react-i18next";
import { IconDownload, IconWand } from "@tabler/icons-react";
import type { AutoInpaintingEntryScope } from "../lib/autoInpaintingSelection";
import { Button } from "./ui/Button";
import { ChevronDownIcon } from "./ui/icons";
import { ControlTooltip } from "./ui/ControlTooltip";
import { ChapterTaskHeader } from "./ChapterTaskHeader";
import { areChapterTaskHubPropsEqual } from "./chapterTaskHubMemo";
import type { ChapterTaskHubProps } from "./chapterTaskHubTypes";
import { MenuSurface } from "./ui/MenuSurface";
import { usePopupController } from "./ui/usePopupController";

export function JobCancelButton({
  cancelling,
  onCancel,
}: {
  cancelling: boolean;
  onCancel: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <Button variant="danger" fullWidth disabled={cancelling} onClick={onCancel}>
      {cancelling ? t("statusDock.cancelling") : t("statusDock.cancelJob")}
    </Button>
  );
}

export const ChapterTaskHub = React.memo(function ChapterTaskHub(
  props: ChapterTaskHubProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const actionsDisabled =
    !props.currentChapter || props.jobActive || props.flowActive;
  return (
    <section className="run-panel chapter-task-hub">
      <ChapterTaskHeader
        currentChapter={props.currentChapter}
        saveStatus={props.saveStatus}
        onRetrySave={props.onRetrySave}
      />
      <div className="run-primary-actions">
        <Button
          variant="primary"
          fullWidth
          onClick={props.onOpenTranslateOptions}
          disabled={actionsDisabled}
        >
          {t("translationOptions.title")}
        </Button>
        {props.currentChapter && props.hasSelectedPage ? (
          <CurrentPageActionsSection
            actionsDisabled={actionsDisabled}
            canRunBubbleLayout={props.canRunBubbleLayout}
            hasSelectedPage={props.hasSelectedPage}
            onOpenAutoInpaintingOptions={props.onOpenAutoInpaintingOptions}
            onOpenExport={props.onOpenExport}
            onRunBubbleLayout={props.onRunBubbleLayout}
            onRunCurrentPageInpainting={props.onRunCurrentPageInpainting}
          />
        ) : null}
      </div>
    </section>
  );
}, areChapterTaskHubPropsEqual);

function CurrentPageActionsSection({
  actionsDisabled,
  canRunBubbleLayout,
  hasSelectedPage,
  onOpenAutoInpaintingOptions,
  onOpenExport,
  onRunBubbleLayout,
  onRunCurrentPageInpainting,
}: {
  actionsDisabled: boolean;
  canRunBubbleLayout: boolean;
  hasSelectedPage: boolean;
  onOpenAutoInpaintingOptions: (scope: AutoInpaintingEntryScope) => void;
  onOpenExport: () => void;
  onRunBubbleLayout: () => void;
  onRunCurrentPageInpainting: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="current-page-actions-section">
      <small className="current-page-actions-label">
        {t("runPanel.currentPage")}
      </small>
      <div className="current-page-actions">
        <AutomaticEraseActions
          disabled={actionsDisabled || !hasSelectedPage}
          onOpenScope={onOpenAutoInpaintingOptions}
          onRunCurrentPage={onRunCurrentPageInpainting}
        />
        <BubbleLayoutAction
          canRun={canRunBubbleLayout}
          disabled={actionsDisabled || !canRunBubbleLayout}
          onRun={onRunBubbleLayout}
        />
        <Button
          aria-label={t("inpainting.export.pngAction")}
          className="current-page-export-action"
          disabled={actionsDisabled}
          fullWidth
          iconLeft={<IconDownload size={16} stroke={2.1} />}
          onClick={onOpenExport}
          size="sm"
        >
          {t("inpainting.export.pngAction")}
        </Button>
      </div>
    </div>
  );
}

function BubbleLayoutAction({
  canRun,
  disabled,
  onRun,
}: {
  canRun: boolean;
  disabled: boolean;
  onRun: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const label = t("inpainting.auto.bubbleLayoutAction");
  return (
    <ControlTooltip
      className="current-page-action-tooltip"
      content={canRun ? label : t("inpainting.auto.bubbleLayoutRequiresBlocks")}
      placement="top"
    >
      <Button
        aria-label={label}
        disabled={disabled}
        fullWidth
        iconLeft={<IconWand size={17} stroke={2.1} />}
        onClick={onRun}
      >
        {t("inpainting.auto.bubbleLayoutShort")}
      </Button>
    </ControlTooltip>
  );
}

function AutomaticEraseActions({
  disabled,
  onOpenScope,
  onRunCurrentPage,
}: {
  disabled: boolean;
  onOpenScope: (scope: AutoInpaintingEntryScope) => void;
  onRunCurrentPage: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const [menuOpen, setMenuOpen] = React.useState(false);
  const { close, contentRef, rootRef, toggle, triggerRef } = usePopupController(
    {
      disabled,
      initialFocus: '[role="menuitem"]:not(:disabled)',
      open: menuOpen,
      onOpenChange: setMenuOpen,
    },
  );

  return (
    <div className="auto-inpainting-action" ref={rootRef}>
      <Button
        aria-label={t("inpainting.auto.currentPageAction")}
        disabled={disabled}
        fullWidth
        onClick={onRunCurrentPage}
      >
        {t("inpainting.auto.eraseShort")}
      </Button>
      <Button
        ref={triggerRef}
        className="auto-inpainting-menu-trigger"
        variant="ghost"
        aria-label={t("inpainting.auto.moreActions")}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={disabled}
        onClick={toggle}
      >
        <ChevronDownIcon size={16} />
      </Button>
      {menuOpen && !disabled ? (
        <AutomaticEraseMenu
          menuRef={contentRef}
          onClose={close}
          onOpenScope={onOpenScope}
        />
      ) : null}
    </div>
  );
}

function AutomaticEraseMenu({
  menuRef,
  onClose,
  onOpenScope,
}: {
  menuRef: React.RefObject<HTMLDivElement | null>;
  onClose: (restoreFocus?: boolean) => void;
  onOpenScope: (scope: AutoInpaintingEntryScope) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const runAndClose = (action: () => void): void => {
    onClose(true);
    action();
  };
  return (
    <MenuSurface
      ref={menuRef}
      className="auto-inpainting-menu"
      ariaLabel={t("inpainting.auto.moreActions")}
      onClose={onClose}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => runAndClose(() => onOpenScope("all"))}
      >
        <span>{t("inpainting.auto.allPagesErase")}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => runAndClose(() => onOpenScope("select"))}
      >
        <span>{t("inpainting.auto.selectPagesErase")}</span>
      </button>
    </MenuSurface>
  );
}
