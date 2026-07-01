import React from "react";
import type { CSSProperties } from "react";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { JobState } from "../../../shared/jobTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { EditorPanelSlot } from "../panels/EditorPanelSlot";
import {
  DisplayControlPanel,
  InpaintingControlPanel,
} from "./InpaintingControlPanel";
import { RunPanel, StatusPanel } from "./RunStatusPanels";
import { Button } from "./ui";

type AreaTranslationProps = {
  areaTranslateSelecting: boolean;
  jobActive: boolean;
  jobState: JobState;
  onCancelJob: () => void;
  onStartAreaTranslate: () => void;
  progressSnapshot: ProgressSnapshot | null;
  selectedPage: MangaPage | null;
  selectedPageImageDataUrl: string;
};

type InpaintingRightRailProps = AreaTranslationProps & {
  selectedBlock: TranslationBlock | null;
};

type TranslationRightRailProps = {
  currentChapter: ChapterSnapshot | null;
  flowActive: boolean;
  jobActive: boolean;
  jobState: JobState;
  onCancelJob: () => void;
  onEnterInpainting: () => void;
  onOpenStyleGuide: () => void;
  onOpenTextView: () => void;
  onOpenTranslateOptions: () => void;
  onToggleBlocks: () => void;
  onToggleChrome: () => void;
  progressSnapshot: ProgressSnapshot | null;
  selectedBlock: TranslationBlock | null;
  showBlockChrome: boolean;
  showProgressBar: boolean;
  showTextBlocks: boolean;
  statusLines: string[];
};

type AreaProgressNumbers = {
  current: number | undefined;
  ratio: number;
  total: number | undefined;
};

export function InpaintingRightRail({
  areaTranslateSelecting,
  jobActive,
  jobState,
  onCancelJob,
  onStartAreaTranslate,
  progressSnapshot,
  selectedBlock,
  selectedPage,
  selectedPageImageDataUrl,
}: InpaintingRightRailProps): React.JSX.Element {
  return (
    <>
      <InpaintingControlPanel />
      {selectedBlock ? <EditorPanelSlot /> : null}
      <AreaTranslationPanel
        areaTranslateSelecting={areaTranslateSelecting}
        jobActive={jobActive}
        jobState={jobState}
        onCancelJob={onCancelJob}
        onStartAreaTranslate={onStartAreaTranslate}
        progressSnapshot={progressSnapshot}
        selectedPage={selectedPage}
        selectedPageImageDataUrl={selectedPageImageDataUrl}
      />
    </>
  );
}

export function TranslationRightRail({
  currentChapter,
  jobActive,
  flowActive,
  showProgressBar,
  progressSnapshot,
  jobState,
  onOpenTranslateOptions,
  onEnterInpainting,
  onCancelJob,
  showBlockChrome,
  showTextBlocks,
  onToggleChrome,
  onToggleBlocks,
  onOpenTextView,
  onOpenStyleGuide,
  selectedBlock,
  statusLines,
}: TranslationRightRailProps): React.JSX.Element {
  return (
    <>
      <RunPanel
        currentChapter={currentChapter}
        jobActive={jobActive}
        flowActive={flowActive}
        showProgressBar={showProgressBar}
        progressSnapshot={progressSnapshot}
        jobState={jobState}
        onOpenTranslateOptions={onOpenTranslateOptions}
        onEnterInpainting={onEnterInpainting}
        onCancelJob={onCancelJob}
      />
      <DisplayControlPanel
        showBlockChrome={showBlockChrome}
        showTextBlocks={showTextBlocks}
        canOpenTextView={Boolean(currentChapter)}
        onToggleChrome={onToggleChrome}
        onToggleBlocks={onToggleBlocks}
        onOpenTextView={onOpenTextView}
        onOpenStyleGuide={onOpenStyleGuide}
      />
      {!selectedBlock ? (
        <StatusPanel jobState={jobState} statusLines={statusLines} />
      ) : null}
      <EditorPanelSlot />
    </>
  );
}

function AreaTranslationPanel({
  areaTranslateSelecting,
  jobActive,
  jobState,
  onCancelJob,
  onStartAreaTranslate,
  progressSnapshot,
  selectedPage,
  selectedPageImageDataUrl,
}: AreaTranslationProps): React.JSX.Element {
  return (
    <section className="inpainting-area-translate-panel">
      <h2>영역 번역</h2>
      <button
        className={`area-translate-button ${areaTranslateSelecting ? "active" : ""}`}
        disabled={!selectedPage || !selectedPageImageDataUrl || jobActive}
        onClick={onStartAreaTranslate}
      >
        {areaTranslateSelecting ? "선택 취소" : "영역 번역"}
      </button>
      {shouldShowAreaTranslationProgress(jobState) ? (
        <AreaTranslationProgressCard
          jobState={jobState}
          progressSnapshot={progressSnapshot}
          onCancel={onCancelJob}
        />
      ) : null}
    </section>
  );
}

function AreaTranslationProgressCard({
  jobState,
  progressSnapshot,
  onCancel,
}: {
  jobState: JobState;
  progressSnapshot: ProgressSnapshot | null;
  onCancel: () => void;
}): React.JSX.Element {
  const progress = resolveAreaProgressNumbers(jobState, progressSnapshot);
  const indeterminate = progressSnapshot?.mode === "indeterminate";

  return (
    <div className={`area-translate-progress-card ${jobState.status}`}>
      <ProgressMeta
        current={progress.current}
        indeterminate={indeterminate}
        progressText={jobState.progressText}
        total={progress.total}
      />
      {jobState.detail ? (
        <small className="progress-detail">{jobState.detail}</small>
      ) : null}
      <ProgressTrack
        indeterminate={indeterminate}
        ratio={progress.ratio}
        showWidth={progressSnapshot?.mode === "determinate"}
      />
      {isCancellableJob(jobState) ? (
        <Button variant="danger" size="sm" fullWidth onClick={onCancel}>
          취소
        </Button>
      ) : null}
    </div>
  );
}

function ProgressMeta({
  current,
  indeterminate,
  progressText,
  total,
}: {
  current: number | undefined;
  indeterminate: boolean;
  progressText: string;
  total: number | undefined;
}): React.JSX.Element {
  return (
    <div className="progress-meta">
      <span>{progressText}</span>
      {hasDeterminateProgress(current, total) ? (
        <strong>
          {current} / {total}
        </strong>
      ) : (
        <strong>{indeterminate ? "준비 중" : "진행 중"}</strong>
      )}
    </div>
  );
}

function ProgressTrack({
  indeterminate,
  ratio,
  showWidth,
}: {
  indeterminate: boolean;
  ratio: number;
  showWidth: boolean;
}): React.JSX.Element {
  return (
    <div
      className={`progress-track ${indeterminate ? "indeterminate" : ""}`}
      aria-hidden="true"
    >
      <div
        className={`progress-fill ${indeterminate ? "indeterminate" : ""}`}
        style={resolveProgressFillStyle(ratio, showWidth)}
      />
    </div>
  );
}

function shouldShowAreaTranslationProgress(jobState: JobState): boolean {
  return (
    jobState.kind === "gemma-analysis" &&
    jobState.status !== "idle" &&
    jobState.status !== "completed" &&
    jobState.status !== "cancelled"
  );
}

function resolveAreaProgressNumbers(
  jobState: JobState,
  progressSnapshot: ProgressSnapshot | null,
): AreaProgressNumbers {
  if (progressSnapshot?.mode === "determinate") {
    return {
      current: progressSnapshot.current,
      ratio: progressSnapshot.ratio,
      total: progressSnapshot.total,
    };
  }
  const current = jobState.progressCurrent;
  const total = jobState.progressTotal;
  return {
    current,
    ratio: resolveProgressRatio(current, total),
    total,
  };
}

function resolveProgressRatio(
  current: number | undefined,
  total: number | undefined,
): number {
  return hasDeterminateProgress(current, total)
    ? Math.min(1, Math.max(0, (current ?? 0) / (total ?? 1)))
    : 0;
}

function resolveProgressFillStyle(
  ratio: number,
  showWidth: boolean,
): CSSProperties | undefined {
  return showWidth || ratio > 0
    ? { width: `${Math.round(ratio * 100)}%` }
    : undefined;
}

function hasDeterminateProgress(
  current: number | undefined,
  total: number | undefined,
): boolean {
  return Number.isFinite(current) && Number.isFinite(total) && (total ?? 0) > 0;
}

function isCancellableJob(jobState: JobState): boolean {
  return jobState.status === "starting" || jobState.status === "running";
}
