import React from "react";
import type { ChapterSnapshot, JobState, MangaPage, TranslationBlock } from "../../../shared/types";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { EditorPanel } from "./EditorPanel";
import { DisplayControlPanel, InpaintingControlPanel } from "./InpaintingControlPanel";
import { RunPanel, StatusPanel } from "./RunStatusPanels";

type AppRightRailProps = {
  inpaintingMode: boolean;
  currentChapter: ChapterSnapshot | null;
  selectedPage: MangaPage | null;
  selectedBlock: TranslationBlock | null;
  selectedPageImageDataUrl: string;
  selectedPageEditLocked: boolean;
  jobState: JobState;
  progressSnapshot: ProgressSnapshot | null;
  showProgressBar: boolean;
  showBlockChrome: boolean;
  showTextBlocks: boolean;
  jobActive: boolean;
  statusLines: string[];
  areaTranslateSelecting: boolean;
  onToggleChrome: () => void;
  onToggleBlocks: () => void;
  onRunPending: () => void;
  onRunAll: () => void;
  onEnterInpainting: () => void;
  onCancelJob: () => void;
  onStartAreaTranslate: () => void;
  onUpdateBlock: (patch: Partial<TranslationBlock>) => void;
  onDeleteBlock: () => void;
  onDuplicateBlock: () => void;
};

export function AppRightRail({
  inpaintingMode,
  currentChapter,
  selectedPage,
  selectedBlock,
  selectedPageImageDataUrl,
  selectedPageEditLocked,
  jobState,
  progressSnapshot,
  showProgressBar,
  showBlockChrome,
  showTextBlocks,
  jobActive,
  statusLines,
  areaTranslateSelecting,
  onToggleChrome,
  onToggleBlocks,
  onRunPending,
  onRunAll,
  onEnterInpainting,
  onCancelJob,
  onStartAreaTranslate,
  onUpdateBlock,
  onDeleteBlock,
  onDuplicateBlock
}: AppRightRailProps): React.JSX.Element {
  const editorDisabled = selectedPageEditLocked || jobActive;

  return (
    <aside className={`right-rail ${inpaintingMode ? "inpainting-rail" : ""}`}>
      {inpaintingMode ? (
        <>
          <InpaintingControlPanel />
          {selectedBlock ? (
            <EditorPanel
              block={selectedBlock}
              disabled={editorDisabled}
              onUpdate={onUpdateBlock}
              onDelete={onDeleteBlock}
              onDuplicate={onDuplicateBlock}
            />
          ) : null}
        </>
      ) : (
        <>
          <RunPanel
            currentChapter={currentChapter}
            jobActive={jobActive}
            showProgressBar={showProgressBar}
            progressSnapshot={progressSnapshot}
            jobState={jobState}
            onRunPending={onRunPending}
            onRunAll={onRunAll}
            onEnterInpainting={onEnterInpainting}
            onCancelJob={onCancelJob}
          />

          <DisplayControlPanel showBlockChrome={showBlockChrome} showTextBlocks={showTextBlocks} onToggleChrome={onToggleChrome} onToggleBlocks={onToggleBlocks} />

          {!selectedBlock ? <StatusPanel jobState={jobState} statusLines={statusLines} /> : null}

          <EditorPanel
            block={selectedBlock}
            disabled={editorDisabled}
            areaTranslateAvailable={Boolean(selectedPage && selectedPageImageDataUrl && !jobActive)}
            areaTranslateSelecting={areaTranslateSelecting}
            onStartAreaTranslate={onStartAreaTranslate}
            onUpdate={onUpdateBlock}
            onDelete={onDeleteBlock}
            onDuplicate={onDuplicateBlock}
          />
        </>
      )}
    </aside>
  );
}
