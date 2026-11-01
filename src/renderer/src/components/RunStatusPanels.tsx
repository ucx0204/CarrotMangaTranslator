import React from "react";
import { useTranslation } from "react-i18next";
import { IconEraser, IconWand } from "@tabler/icons-react";
import type { AutoInpaintingEntryScope } from "../lib/autoInpaintingSelection";
import { Button } from "./ui/Button";
import { ControlTooltip } from "./ui/ControlTooltip";
import { ChapterOutputActions } from "./ChapterOutputActions";
import { areChapterTaskHubPropsEqual } from "./chapterTaskHubMemo";
import type { ChapterTaskHubProps } from "./chapterTaskHubTypes";

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
      <div className="run-primary-actions">
        <div className="run-translation-action-row">
          <Button
            variant="primary"
            fullWidth
            onClick={props.onOpenTranslateOptions}
            disabled={!props.currentChapter}
          >
            {props.translateLabel ?? t("translationOptions.workspaceAction")}
          </Button>
          <Button
            variant="primary"
            fullWidth
            onClick={props.onOpenChat}
            disabled={!props.onOpenChat}
          >
            {props.chatTranslateLabel ?? t("chat.translateInChat")}
          </Button>
        </div>
        <ChapterOutputActions
          available={Boolean(props.currentChapter?.pages.length)}
          exportLabel={props.exportLabel}
          linkedWorkspaceStatus={props.linkedWorkspaceStatus}
          linkedWorkspaceViewBusy={props.linkedWorkspaceViewBusy}
          linkedWorkspaceOrganizing={props.linkedWorkspaceOrganizing}
          viewResultsLabel={props.viewResultsLabel}
          onRetryLinkedResults={props.onRetryLinkedResults}
          onOpenPreviousLinkedResults={props.onOpenPreviousLinkedResults}
          onOpenExport={props.onOpenExport}
          onOpenPsdExport={props.onOpenPsdExport}
          onViewLinkedResults={props.onViewLinkedResults}
          psdExportLabel={props.psdExportLabel}
        />
        {props.currentChapter && props.hasSelectedPage ? (
          <CurrentPageActionsSection
            actionsDisabled={actionsDisabled}
            canRunBubbleLayout={props.canRunBubbleLayout}
            hasSelectedPage={props.hasSelectedPage}
            onOpenAutoInpaintingOptions={props.onOpenAutoInpaintingOptions}
            onRunBubbleLayout={props.onRunBubbleLayout}
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
  onRunBubbleLayout,
}: {
  actionsDisabled: boolean;
  canRunBubbleLayout: boolean;
  hasSelectedPage: boolean;
  onOpenAutoInpaintingOptions: (scope: AutoInpaintingEntryScope) => void;
  onRunBubbleLayout: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="current-page-actions-section">
      <h3 className="current-page-actions-title">
        {t("runPanel.pageActions")}
      </h3>
      <div className="current-page-actions">
        <AutomaticEraseActions
          disabled={!hasSelectedPage}
          onOpenScope={onOpenAutoInpaintingOptions}
        />
        <BubbleLayoutAction
          canRun={canRunBubbleLayout}
          disabled={actionsDisabled || !canRunBubbleLayout}
          onRun={onRunBubbleLayout}
        />
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
        iconLeft={<IconWand size={16} stroke={2.1} />}
        onClick={onRun}
        size="sm"
      >
        {t("inpainting.auto.bubbleLayoutShort")}
      </Button>
    </ControlTooltip>
  );
}

function AutomaticEraseActions({
  disabled,
  onOpenScope,
}: {
  disabled: boolean;
  onOpenScope: (scope: AutoInpaintingEntryScope) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <Button
      aria-label={t("inpainting.auto.currentPageAction")}
      title={t("inpainting.auto.currentPageAction")}
      disabled={disabled}
      fullWidth
      iconLeft={<IconEraser size={16} stroke={2.1} />}
      onClick={() => onOpenScope("select")}
      size="sm"
    >
      {t("inpainting.auto.eraseShort")}
    </Button>
  );
}
