import React from "react";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { JobState } from "../../../shared/jobTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { BlockFormatGroupId } from "../../../shared/blockFormat";
import type { FormatApplyScope } from "../hooks/useBlockEditingActions";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { InpaintingRightRail, TranslationRightRail } from "./rightRailPanels";

type AppRightRailProps = {
  inpaintingMode: boolean;
  currentChapter: ChapterSnapshot | null;
  selectedPage: MangaPage | null;
  selectedBlock: TranslationBlock | null;
  selectedBlockCount: number;
  selectedPageImageDataUrl: string;
  selectedPageEditLocked: boolean;
  jobState: JobState;
  progressSnapshot: ProgressSnapshot | null;
  showProgressBar: boolean;
  showBlockChrome: boolean;
  showTextBlocks: boolean;
  jobActive: boolean;
  flowActive: boolean;
  statusLines: string[];
  areaTranslateSelecting: boolean;
  onToggleChrome: () => void;
  onToggleBlocks: () => void;
  onOpenTextView: () => void;
  onOpenStyleGuide: () => void;
  onOpenTranslateOptions: () => void;
  onEnterInpainting: () => void;
  onCancelJob: () => void;
  onStartAreaTranslate: () => void;
  onApplyFormat: (
    scope: FormatApplyScope,
    groupIds: BlockFormatGroupId[],
  ) => void;
  onUpdateBlock: (patch: Partial<TranslationBlock>) => void;
  onDeleteBlock: () => void;
  onDuplicateBlock: () => void;
};

export function AppRightRail(props: AppRightRailProps): React.JSX.Element {
  const editorDisabled =
    props.selectedPageEditLocked || (props.inpaintingMode && props.jobActive);

  return (
    <aside
      className={`right-rail ${props.inpaintingMode ? "inpainting-rail" : ""}`}
    >
      {props.inpaintingMode ? (
        <InpaintingRailContent
          editorDisabled={editorDisabled}
          railProps={props}
        />
      ) : (
        <TranslationRailContent
          editorDisabled={editorDisabled}
          railProps={props}
        />
      )}
    </aside>
  );
}

function InpaintingRailContent({
  editorDisabled,
  railProps,
}: {
  editorDisabled: boolean;
  railProps: AppRightRailProps;
}): React.JSX.Element {
  return (
    <InpaintingRightRail
      areaTranslateSelecting={railProps.areaTranslateSelecting}
      editorDisabled={editorDisabled}
      jobActive={railProps.jobActive}
      jobState={railProps.jobState}
      onApplyFormat={railProps.onApplyFormat}
      onBlockDelete={railProps.onDeleteBlock}
      onBlockDuplicate={railProps.onDuplicateBlock}
      onBlockUpdate={railProps.onUpdateBlock}
      onCancelJob={railProps.onCancelJob}
      onStartAreaTranslate={railProps.onStartAreaTranslate}
      progressSnapshot={railProps.progressSnapshot}
      selectedBlock={railProps.selectedBlock}
      selectedBlockCount={railProps.selectedBlockCount}
      selectedPage={railProps.selectedPage}
      selectedPageImageDataUrl={railProps.selectedPageImageDataUrl}
    />
  );
}

function TranslationRailContent({
  editorDisabled,
  railProps,
}: {
  editorDisabled: boolean;
  railProps: AppRightRailProps;
}): React.JSX.Element {
  return (
    <TranslationRightRail
      areaTranslateSelecting={railProps.areaTranslateSelecting}
      currentChapter={railProps.currentChapter}
      editorDisabled={editorDisabled}
      flowActive={railProps.flowActive}
      jobActive={railProps.jobActive}
      jobState={railProps.jobState}
      onApplyFormat={railProps.onApplyFormat}
      onBlockDelete={railProps.onDeleteBlock}
      onBlockDuplicate={railProps.onDuplicateBlock}
      onBlockUpdate={railProps.onUpdateBlock}
      onCancelJob={railProps.onCancelJob}
      onEnterInpainting={railProps.onEnterInpainting}
      onOpenStyleGuide={railProps.onOpenStyleGuide}
      onOpenTextView={railProps.onOpenTextView}
      onOpenTranslateOptions={railProps.onOpenTranslateOptions}
      onStartAreaTranslate={railProps.onStartAreaTranslate}
      onToggleBlocks={railProps.onToggleBlocks}
      onToggleChrome={railProps.onToggleChrome}
      progressSnapshot={railProps.progressSnapshot}
      selectedBlock={railProps.selectedBlock}
      selectedBlockCount={railProps.selectedBlockCount}
      selectedPage={railProps.selectedPage}
      selectedPageImageDataUrl={railProps.selectedPageImageDataUrl}
      showBlockChrome={railProps.showBlockChrome}
      showProgressBar={railProps.showProgressBar}
      showTextBlocks={railProps.showTextBlocks}
      statusLines={railProps.statusLines}
    />
  );
}
