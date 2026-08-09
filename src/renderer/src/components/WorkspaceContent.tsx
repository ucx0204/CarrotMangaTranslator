import React from "react";
import { useTranslation } from "react-i18next";
import { isBlockEditingTool, isRetouchTool } from "../lib/stageTool";
import { formatCombo } from "../lib/shortcuts/comboFromEvent";
import type { AppWorkspaceProps } from "./appWorkspaceTypes";
import { ImageStage, type ImageStageProps } from "./ImageStage";
import { Button } from "./ui/Button";

export const WorkspaceContent = React.memo(function WorkspaceContent(
  props: AppWorkspaceProps,
): React.JSX.Element {
  const retouchToolActive = isRetouchTool(props.stageTool);
  const selectedPageWidth = props.selectedPage?.width ?? null;
  const selectedPageHeight = props.selectedPage?.height ?? null;
  const textLayoutStageSize = React.useMemo<ImageStageProps["stageSize"]>(
    () =>
      selectedPageWidth !== null && selectedPageHeight !== null
        ? { width: selectedPageWidth, height: selectedPageHeight }
        : props.stageSize,
    [props.stageSize, selectedPageHeight, selectedPageWidth],
  );
  if (!props.selectedPage) {
    return (
      <EmptyWorkspace
        onOpenBatchImport={props.onOpenBatchImport}
        onOpenSettings={props.onOpenSettings}
        onOpenShareImport={props.onOpenShareImport}
        onOpenTranslationSource={props.onOpenTranslationSource}
      />
    );
  }
  return (
    <WorkspacePane
      blockPointerDisabled={
        props.jobActive || !isBlockEditingTool(props.stageTool)
      }
      hideEditingOverlays={
        props.showingOriginalPeek ||
        props.selectedPageImagePageId !== props.selectedPage.id
      }
      imageDataUrl={props.selectedPageImageDataUrl}
      imageLoading={props.selectedPageImageLoading}
      imageRef={props.imageRef}
      interactionPreviewStore={props.interactionPreviewStore}
      maskStrokes={props.maskStrokes}
      onBlockPointerDown={props.onBlockPointerDown}
      onStagePointerDown={props.onStagePointerDown}
      onStagePointerLeave={props.onStagePointerLeave}
      onStagePointerMove={props.onStagePointerMove}
      onStagePointerUp={props.onStagePointerUp}
      page={props.selectedPage}
      regionSelectionActive={props.regionSelectionActive}
      regionSelectionRect={props.regionSelectionRect}
      retouchCursor={props.retouchCursor}
      retouchOriginalImageDataUrl={props.retouchOriginalImageDataUrl}
      selectedBlockId={props.selectedBlockId}
      selectedBlockIds={props.selectedBlockIds}
      showBlockChrome={props.showBlockChrome && !retouchToolActive}
      showingOriginalPeek={props.showingOriginalPeek}
      showTextBlocks={props.showTextBlocks}
      stageRef={props.stageRef}
      stageSize={props.stageSize}
      stageTool={props.stageTool}
      textLayoutStageSize={textLayoutStageSize}
    />
  );
}, areWorkspaceContentPropsEqual);

function areWorkspaceContentPropsEqual(
  previous: AppWorkspaceProps,
  next: AppWorkspaceProps,
): boolean {
  return WORKSPACE_CONTENT_RENDER_KEYS.every((key) =>
    Object.is(previous[key], next[key]),
  );
}

const WORKSPACE_CONTENT_RENDER_KEYS = [
  "imageRef",
  "interactionPreviewStore",
  "jobActive",
  "maskStrokes",
  "onBlockPointerDown",
  "onOpenBatchImport",
  "onOpenSettings",
  "onOpenShareImport",
  "onOpenTranslationSource",
  "onStagePointerDown",
  "onStagePointerLeave",
  "onStagePointerMove",
  "onStagePointerUp",
  "regionSelectionActive",
  "regionSelectionRect",
  "retouchCursor",
  "retouchOriginalImageDataUrl",
  "selectedBlockId",
  "selectedBlockIds",
  "selectedPage",
  "selectedPageImageDataUrl",
  "selectedPageImageLoading",
  "selectedPageImagePageId",
  "showBlockChrome",
  "showTextBlocks",
  "showingOriginalPeek",
  "stageRef",
  "stageSize",
  "stageTool",
] as const satisfies readonly (keyof AppWorkspaceProps)[];

function WorkspacePane({
  showingOriginalPeek,
  ...stageProps
}: ImageStageProps & {
  showingOriginalPeek: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="workspace-pane">
      {showingOriginalPeek ? (
        <div className="peek-original-badge">{t("common.original")}</div>
      ) : null}
      <ImageStage {...stageProps} />
    </div>
  );
}

function EmptyWorkspace({
  onOpenBatchImport,
  onOpenSettings,
  onOpenShareImport,
  onOpenTranslationSource,
}: Pick<
  AppWorkspaceProps,
  | "onOpenBatchImport"
  | "onOpenSettings"
  | "onOpenShareImport"
  | "onOpenTranslationSource"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="empty-state">
      <div className="empty-card">
        <h2>{t("workspace.empty.title")}</h2>
        <p>{t("workspace.empty.description")}</p>
        <EmptyWorkspaceSteps
          onOpenSettings={onOpenSettings}
          onOpenTranslationSource={onOpenTranslationSource}
        />
        <div className="empty-actions">
          <Button variant="primary" onClick={onOpenTranslationSource}>
            {t("workspace.empty.startTranslation")}
          </Button>
          <Button onClick={onOpenBatchImport}>
            {t("sidebar.batchTranslate")}
          </Button>
          <Button onClick={onOpenShareImport}>
            {t("workspace.empty.importSharedCopy")}
          </Button>
        </div>
        <p className="empty-hints">
          <kbd>←</kbd> <kbd>→</kbd> {t("workspace.empty.hints.pageNavigation")}{" "}
          ·{" "}
          {formatCombo("ctrl+k").map((key, index) => (
            <React.Fragment key={`${key}-${index}`}>
              {index > 0 ? "+" : null}
              <kbd>{key}</kbd>
            </React.Fragment>
          ))}{" "}
          {t("workspace.empty.hints.commandPalette")} · <kbd>?</kbd>{" "}
          {t("workspace.empty.hints.shortcuts")}
        </p>
      </div>
    </div>
  );
}

function EmptyWorkspaceSteps({
  onOpenSettings,
  onOpenTranslationSource,
}: Pick<
  AppWorkspaceProps,
  "onOpenSettings" | "onOpenTranslationSource"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <ol className="empty-steps">
      <li>
        <span className="empty-step-num">1</span>
        <div className="empty-step-body">
          <strong>{t("workspace.empty.steps.engine.title")}</strong>
          <span>{t("workspace.empty.steps.engine.description")}</span>
        </div>
        <Button size="sm" onClick={onOpenSettings}>
          {t("workspace.empty.openSettings")}
        </Button>
      </li>
      <li>
        <span className="empty-step-num">2</span>
        <div className="empty-step-body">
          <strong>{t("workspace.empty.steps.import.title")}</strong>
          <span>{t("workspace.empty.steps.import.description")}</span>
        </div>
        <Button size="sm" onClick={onOpenTranslationSource}>
          {t("sidebar.translate")}
        </Button>
      </li>
      <li>
        <span className="empty-step-num">3</span>
        <div className="empty-step-body">
          <strong>{t("workspace.empty.steps.edit.title")}</strong>
          <span>{t("workspace.empty.steps.edit.description")}</span>
        </div>
      </li>
    </ol>
  );
}
