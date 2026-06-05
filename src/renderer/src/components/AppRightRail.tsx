import React from "react";
import type { ChapterSnapshot, JobState, MangaPage, TranslationBlock } from "../../../shared/types";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { EditorPanel } from "./EditorPanel";
import { DisplayControlPanel, InpaintingControlPanel } from "./InpaintingControlPanel";
import { RunPanel, StatusPanel } from "./RunStatusPanels";
import { Button } from "./ui";

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
  onApplyFont: (scope: "page" | "chapter", fontFamily?: string) => void;
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
  onApplyFont,
  onUpdateBlock,
  onDeleteBlock,
  onDuplicateBlock
}: AppRightRailProps): React.JSX.Element {
  const editorDisabled = selectedPageEditLocked || (inpaintingMode && jobActive);
  const showAreaTranslationProgress =
    inpaintingMode &&
    jobState.kind === "gemma-analysis" &&
    jobState.status !== "idle" &&
    jobState.status !== "completed" &&
    jobState.status !== "cancelled";

  return (
    <aside className={`right-rail ${inpaintingMode ? "inpainting-rail" : ""}`}>
      {inpaintingMode ? (
        <>
          <InpaintingControlPanel />
          {selectedBlock ? (
            <EditorPanel
              block={selectedBlock}
              disabled={editorDisabled}
              disableChapterFontApply={jobActive}
              onApplyFont={onApplyFont}
              onUpdate={onUpdateBlock}
              onDelete={onDeleteBlock}
              onDuplicate={onDuplicateBlock}
            />
          ) : null}
          <section className="inpainting-area-translate-panel">
            <h2>영역 번역</h2>
            <button
              className={`area-translate-button ${areaTranslateSelecting ? "active" : ""}`}
              disabled={!selectedPage || !selectedPageImageDataUrl || jobActive}
              onClick={onStartAreaTranslate}
            >
              {areaTranslateSelecting ? "선택 취소" : "영역 번역"}
            </button>
            {showAreaTranslationProgress ? (
              <AreaTranslationProgressCard jobState={jobState} progressSnapshot={progressSnapshot} onCancel={onCancelJob} />
            ) : null}
          </section>
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
            disableChapterFontApply={jobActive}
            areaTranslateAvailable={Boolean(selectedPage && selectedPageImageDataUrl && !jobActive)}
            areaTranslateSelecting={areaTranslateSelecting}
            onStartAreaTranslate={onStartAreaTranslate}
            onApplyFont={onApplyFont}
            onUpdate={onUpdateBlock}
            onDelete={onDeleteBlock}
            onDuplicate={onDuplicateBlock}
          />
        </>
      )}
    </aside>
  );
}

function AreaTranslationProgressCard({
  jobState,
  progressSnapshot,
  onCancel
}: {
  jobState: JobState;
  progressSnapshot: ProgressSnapshot | null;
  onCancel: () => void;
}): React.JSX.Element {
  const current = progressSnapshot?.mode === "determinate" ? progressSnapshot.current : jobState.progressCurrent;
  const total = progressSnapshot?.mode === "determinate" ? progressSnapshot.total : jobState.progressTotal;
  const ratio =
    progressSnapshot?.mode === "determinate"
      ? progressSnapshot.ratio
      : Number.isFinite(current) && Number.isFinite(total) && (total ?? 0) > 0
        ? Math.min(1, Math.max(0, (current ?? 0) / (total ?? 1)))
        : 0;
  const canCancel = jobState.status === "starting" || jobState.status === "running";

  return (
    <div className={`area-translate-progress-card ${jobState.status}`}>
      <div className="progress-meta">
        <span>{jobState.progressText}</span>
        {Number.isFinite(current) && Number.isFinite(total) && (total ?? 0) > 0 ? (
          <strong>
            {current} / {total}
          </strong>
        ) : (
          <strong>{progressSnapshot?.mode === "indeterminate" ? "준비 중" : "진행 중"}</strong>
        )}
      </div>
      {jobState.detail ? <small className="progress-detail">{jobState.detail}</small> : null}
      <div className={`progress-track ${progressSnapshot?.mode === "indeterminate" ? "indeterminate" : ""}`} aria-hidden="true">
        <div
          className={`progress-fill ${progressSnapshot?.mode === "indeterminate" ? "indeterminate" : ""}`}
          style={progressSnapshot?.mode === "determinate" || ratio > 0 ? { width: `${Math.round(ratio * 100)}%` } : undefined}
        />
      </div>
      {canCancel ? (
        <Button variant="danger" size="sm" fullWidth onClick={onCancel}>
          취소
        </Button>
      ) : null}
    </div>
  );
}
