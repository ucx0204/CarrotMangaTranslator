import React from "react";
import { useTranslation } from "react-i18next";
import {
  IconAlertTriangle,
  IconDownload,
  IconFolderOpen,
  IconLayersSelected,
  IconWand,
} from "@tabler/icons-react";
import type { AutoInpaintingEntryScope } from "../lib/autoInpaintingSelection";
import { Button } from "./ui/Button";
import { ControlTooltip } from "./ui/ControlTooltip";
import { IconButton } from "./ui/IconButton";
import { ChapterTaskHeader } from "./ChapterTaskHeader";
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
      <ChapterTaskHeader
        currentChapter={props.currentChapter}
        saveStatus={props.saveStatus}
        onRetrySave={props.onRetrySave}
      />
      <div className="run-primary-actions">
        <div className="run-translation-action-row">
          <Button
            variant="primary"
            fullWidth
            onClick={props.onOpenTranslateOptions}
            disabled={actionsDisabled}
          >
            {t("translationOptions.workspaceAction")}
          </Button>
          {props.currentChapter ? <TranslationReplacementWarning /> : null}
        </div>
        {props.currentChapter && props.hasSelectedPage ? (
          <CurrentPageActionsSection
            actionsDisabled={actionsDisabled}
            canRunBubbleLayout={props.canRunBubbleLayout}
            hasSelectedPage={props.hasSelectedPage}
            onOpenAutoInpaintingOptions={props.onOpenAutoInpaintingOptions}
            onOpenExport={props.onOpenExport}
            onOpenPsdExport={props.onOpenPsdExport}
            onRunBubbleLayout={props.onRunBubbleLayout}
            linkedWorkspaceStatus={props.linkedWorkspaceStatus}
            linkedWorkspaceViewBusy={props.linkedWorkspaceViewBusy}
            onViewLinkedResults={props.onViewLinkedResults}
          />
        ) : null}
      </div>
    </section>
  );
}, areChapterTaskHubPropsEqual);

function TranslationReplacementWarning(): React.JSX.Element {
  const { t } = useTranslation("components");
  const replacementDescription = t("translationOptions.workspaceUndoWarning");
  return (
    <ControlTooltip
      className="run-panel-translation-warning"
      content={replacementDescription}
      placement="left"
    >
      <IconButton
        className="run-panel-translation-warning-icon"
        label={replacementDescription}
        size="sm"
        title=""
      >
        <IconAlertTriangle size={16} stroke={2} aria-hidden="true" />
      </IconButton>
    </ControlTooltip>
  );
}

function CurrentPageActionsSection({
  actionsDisabled,
  canRunBubbleLayout,
  hasSelectedPage,
  onOpenAutoInpaintingOptions,
  onOpenExport,
  onOpenPsdExport,
  onRunBubbleLayout,
  linkedWorkspaceStatus,
  linkedWorkspaceViewBusy,
  onViewLinkedResults,
}: {
  actionsDisabled: boolean;
  canRunBubbleLayout: boolean;
  hasSelectedPage: boolean;
  onOpenAutoInpaintingOptions: (scope: AutoInpaintingEntryScope) => void;
  onOpenExport: () => void;
  onOpenPsdExport: () => void;
  onRunBubbleLayout: () => void;
  linkedWorkspaceStatus: ChapterTaskHubProps["linkedWorkspaceStatus"];
  linkedWorkspaceViewBusy: boolean;
  onViewLinkedResults: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="current-page-actions-section">
      <h3 className="current-page-actions-title">
        {t("runPanel.pageActions")}
      </h3>
      <div className="current-page-actions">
        <AutomaticEraseActions
          disabled={actionsDisabled || !hasSelectedPage}
          onOpenScope={onOpenAutoInpaintingOptions}
        />
        <BubbleLayoutAction
          canRun={canRunBubbleLayout}
          disabled={actionsDisabled || !canRunBubbleLayout}
          onRun={onRunBubbleLayout}
        />
        <ResultExportActions
          actionsDisabled={actionsDisabled}
          linkedWorkspaceStatus={linkedWorkspaceStatus}
          linkedWorkspaceViewBusy={linkedWorkspaceViewBusy}
          onOpenExport={onOpenExport}
          onOpenPsdExport={onOpenPsdExport}
          onViewLinkedResults={onViewLinkedResults}
        />
      </div>
      {linkedWorkspaceStatus?.connectionId ? (
        <small
          className={`linked-workspace-inline-status ${linkedWorkspaceStatus.state}`}
        >
          {formatLinkedWorkspaceStatus(linkedWorkspaceStatus, t)}
        </small>
      ) : null}
    </div>
  );
}

function ResultExportActions({
  actionsDisabled,
  linkedWorkspaceStatus,
  linkedWorkspaceViewBusy,
  onOpenExport,
  onOpenPsdExport,
  onViewLinkedResults,
}: {
  actionsDisabled: boolean;
  linkedWorkspaceStatus: ChapterTaskHubProps["linkedWorkspaceStatus"];
  linkedWorkspaceViewBusy: boolean;
  onOpenExport: () => void;
  onOpenPsdExport: () => void;
  onViewLinkedResults: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const viewResults = canViewLinkedResults(linkedWorkspaceStatus);
  const resultLabel = t(
    viewResults
      ? "inpainting.export.viewResults"
      : "inpainting.export.resultAction",
  );
  return (
    <>
      <Button
        aria-label={resultLabel}
        className="current-page-export-action"
        disabled={actionsDisabled}
        fullWidth
        iconLeft={
          viewResults ? (
            <IconFolderOpen size={16} stroke={2.1} />
          ) : (
            <IconDownload size={16} stroke={2.1} />
          )
        }
        onClick={viewResults ? onViewLinkedResults : onOpenExport}
        size="sm"
      >
        {linkedWorkspaceViewBusy
          ? t("inpainting.export.preparingResults")
          : resultLabel}
      </Button>
      <Button
        aria-label={t("inpainting.export.psdAction")}
        className="current-page-psd-export-action"
        disabled={actionsDisabled}
        fullWidth
        iconLeft={<IconLayersSelected size={16} stroke={2.1} />}
        onClick={onOpenPsdExport}
        size="sm"
      >
        {t("inpainting.export.psdAction")}
      </Button>
    </>
  );
}

function canViewLinkedResults(
  status: ChapterTaskHubProps["linkedWorkspaceStatus"],
): boolean {
  return Boolean(
    status?.connectionId && !["disabled", "unlinked"].includes(status.state),
  );
}

function formatLinkedWorkspaceStatus(
  status: NonNullable<ChapterTaskHubProps["linkedWorkspaceStatus"]>,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (status.state === "syncing") return t("inpainting.export.syncing");
  if (status.state === "pending") {
    return t("inpainting.export.pendingSync", { count: status.pendingCount });
  }
  if (status.state === "failed") return t("inpainting.export.syncFailed");
  if (status.state === "disabled") return t("inpainting.export.syncDisabled");
  return t("inpainting.export.synced");
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
}: {
  disabled: boolean;
  onOpenScope: (scope: AutoInpaintingEntryScope) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <Button
      aria-label={t("inpainting.auto.currentPageAction")}
      disabled={disabled}
      fullWidth
      onClick={() => onOpenScope("select")}
    >
      {t("inpainting.auto.eraseShort")}
    </Button>
  );
}
