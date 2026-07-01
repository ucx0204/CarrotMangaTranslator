import React from "react";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { JobState } from "../../../shared/jobTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { InpaintingRightRail, TranslationRightRail } from "./rightRailPanels";

type AppRightRailProps = {
  inpaintingMode: boolean;
  currentChapter: ChapterSnapshot | null;
  selectedPage: MangaPage | null;
  selectedBlock: TranslationBlock | null;
  selectedPageImageDataUrl: string;
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
};

// The text-block editor is rendered by EditorPanelContainer, which reads the
// selected block and edit actions from the panel session context rather than
// from these rail props.
export function AppRightRail(props: AppRightRailProps): React.JSX.Element {
  return (
    <aside
      className={`right-rail ${props.inpaintingMode ? "inpainting-rail" : ""}`}
    >
      {props.inpaintingMode ? (
        <InpaintingRailContent railProps={props} />
      ) : (
        <TranslationRailContent railProps={props} />
      )}
    </aside>
  );
}

function InpaintingRailContent({
  railProps,
}: {
  railProps: AppRightRailProps;
}): React.JSX.Element {
  return (
    <InpaintingRightRail
      areaTranslateSelecting={railProps.areaTranslateSelecting}
      jobActive={railProps.jobActive}
      jobState={railProps.jobState}
      onCancelJob={railProps.onCancelJob}
      onStartAreaTranslate={railProps.onStartAreaTranslate}
      progressSnapshot={railProps.progressSnapshot}
      selectedBlock={railProps.selectedBlock}
      selectedPage={railProps.selectedPage}
      selectedPageImageDataUrl={railProps.selectedPageImageDataUrl}
    />
  );
}

function TranslationRailContent({
  railProps,
}: {
  railProps: AppRightRailProps;
}): React.JSX.Element {
  return (
    <TranslationRightRail
      currentChapter={railProps.currentChapter}
      flowActive={railProps.flowActive}
      jobActive={railProps.jobActive}
      jobState={railProps.jobState}
      onCancelJob={railProps.onCancelJob}
      onEnterInpainting={railProps.onEnterInpainting}
      onOpenStyleGuide={railProps.onOpenStyleGuide}
      onOpenTextView={railProps.onOpenTextView}
      onOpenTranslateOptions={railProps.onOpenTranslateOptions}
      onToggleBlocks={railProps.onToggleBlocks}
      onToggleChrome={railProps.onToggleChrome}
      progressSnapshot={railProps.progressSnapshot}
      selectedBlock={railProps.selectedBlock}
      showBlockChrome={railProps.showBlockChrome}
      showProgressBar={railProps.showProgressBar}
      showTextBlocks={railProps.showTextBlocks}
      statusLines={railProps.statusLines}
    />
  );
}
