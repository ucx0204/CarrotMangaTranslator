import React from "react";
import type { ChapterSnapshot, JobState, MangaPage } from "../../../shared/types";
import type { ProgressSnapshot } from "../lib/jobProgress";

export type InpaintingTool = "none" | "brush" | "eraser" | "picker" | "mask";

export type BlockCounts = {
  total: number;
  selectedPage: number;
  pendingTotal: number;
  pendingPages: number;
};

export function InpaintingControlPanel({
  currentChapter,
  selectedPage,
  blockCounts,
  inpaintedPageCount,
  tool,
  brushRadius,
  brushColor,
  maskStrokeCount,
  canUndo,
  canRedo,
  jobState,
  progressSnapshot,
  showBlockChrome,
  showTextBlocks,
  jobActive,
  peekAvailable,
  peeking,
  onSelectTool,
  onBrushRadiusChange,
  onBrushColorChange,
  onUndoRetouch,
  onRedoRetouch,
  onRevertPage,
  onRevertChapter,
  onRunPage,
  onRunChapter,
  onRunDrawnPattern,
  onClearPatternMask,
  onShowGuide,
  onPeekOriginalStart,
  onPeekOriginalEnd,
  onToggleChrome,
  onToggleBlocks,
  onExportResults,
  onCancelJob
}: {
  currentChapter: ChapterSnapshot | null;
  selectedPage: MangaPage | null;
  blockCounts: BlockCounts;
  inpaintedPageCount: number;
  tool: InpaintingTool;
  brushRadius: number;
  brushColor: string;
  maskStrokeCount: number;
  canUndo: boolean;
  canRedo: boolean;
  jobState: JobState;
  progressSnapshot: ProgressSnapshot | null;
  showBlockChrome: boolean;
  showTextBlocks: boolean;
  jobActive: boolean;
  peekAvailable: boolean;
  peeking: boolean;
  onSelectTool: (tool: InpaintingTool) => void;
  onBrushRadiusChange: (radius: number) => void;
  onBrushColorChange: (color: string) => void;
  onUndoRetouch: () => void;
  onRedoRetouch: () => void;
  onRevertPage: () => void;
  onRevertChapter: () => void;
  onRunPage: () => void;
  onRunChapter: () => void;
  onRunDrawnPattern: () => void;
  onClearPatternMask: () => void;
  onShowGuide: () => void;
  onPeekOriginalStart: () => void;
  onPeekOriginalEnd: () => void;
  onToggleChrome: () => void;
  onToggleBlocks: () => void;
  onExportResults: () => void;
  onCancelJob: () => void;
}): React.JSX.Element {
  const activeInpaintingJob = jobState.kind === "inpainting" && jobState.status !== "idle";
  const totalPages = currentChapter?.pages.length ?? 0;
  const pageTargetCount = blockCounts.selectedPage;
  const pendingTargetCount = blockCounts.pendingTotal;

  return (
    <>
      <section className="inpainting-panel stage-panel">
        <div className="panel-header">
          <h2>무늬 배경 지우기</h2>
          <div className="inpainting-header-actions">
            <button
              className={`chip-toggle ${showTextBlocks ? "active" : ""}`}
              onClick={onToggleBlocks}
              title="블록 표시 켜기/끄기"
            >
              블록
            </button>
            <button
              className={`chip-toggle ${showBlockChrome ? "active" : ""}`}
              onClick={onToggleChrome}
              title="배경/테두리 표시 켜기/끄기"
            >
              테두리
            </button>
            <button className="inpainting-guide-button" onClick={onShowGuide}>
              안내
            </button>
          </div>
        </div>

        <div className="inpainting-counts">
          <span className="type-stat nonsolid">이 페이지 {pageTargetCount}</span>
          <span className="type-stat nonsolid">남은 {pendingTargetCount}</span>
          <span className="type-stat review">완료 {inpaintedPageCount}</span>
        </div>

        {activeInpaintingJob ? <InpaintingProgressCard jobState={jobState} progressSnapshot={progressSnapshot} onCancel={onCancelJob} /> : null}

        <div className="inpainting-run-card pattern">
          <span className="inpainting-run-meta">
            {currentChapter
              ? `남은 ${blockCounts.pendingPages} / ${totalPages}페이지 · ${pendingTargetCount}개 블록`
              : "화가 열려 있지 않습니다."}
          </span>
          <div className="inpainting-action-grid">
            <button className="pattern compact" disabled={!selectedPage || jobActive || pageTargetCount === 0} onClick={onRunPage}>
              이 페이지
            </button>
            <button className="pattern compact" disabled={!currentChapter || jobActive || pendingTargetCount === 0} onClick={onRunChapter}>
              남은 페이지
            </button>
          </div>
          <button
            className={`peek-button ${peeking ? "active" : ""}`}
            disabled={!peekAvailable || jobActive}
            onPointerDown={onPeekOriginalStart}
            onPointerUp={onPeekOriginalEnd}
            onPointerLeave={onPeekOriginalEnd}
            onPointerCancel={onPeekOriginalEnd}
          >
            <EyeIcon />
            <span>{peeking ? "원본 표시 중" : "원본 비교 (누르고 있기)"}</span>
          </button>
          <p className="inpainting-hint">블록 모서리의 ‘제외’ 버튼으로 해당 블록을 인페인팅에서 빼거나 다시 넣을 수 있어요.</p>
        </div>
      </section>

      <section className="inpainting-panel drawn-mask-panel">
        <div className="panel-header">
          <h2>그려서 지우기</h2>
          <small>{maskStrokeCount > 0 ? `그린 영역 ${maskStrokeCount}개` : "효과음 보정"}</small>
        </div>
        <div className="retouch-toolbar compact-toolbar">
          <button className={tool === "mask" ? "active mask-tool" : "mask-tool"} disabled={jobActive} onClick={() => onSelectTool(tool === "mask" ? "none" : "mask")}>
            <MaskIcon />
            <span>마스크 붓</span>
          </button>
          <button className="secondary compact" disabled={jobActive || maskStrokeCount === 0} onClick={onClearPatternMask}>
            비우기
          </button>
        </div>
        <button className="pattern compact" disabled={jobActive || !selectedPage || maskStrokeCount === 0} onClick={onRunDrawnPattern}>
          그린 영역 지우기
        </button>
      </section>

      <section className="inpainting-panel mask-tool-panel">
        <div className="panel-header">
          <h2>수동 보정</h2>
          <small>Ctrl+Z / Ctrl+Y</small>
        </div>
        <div className="retouch-toolbar">
          <button className={tool === "brush" ? "active" : ""} disabled={jobActive} onClick={() => onSelectTool(tool === "brush" ? "none" : "brush")}>
            <PaintIcon />
            <span>붓</span>
            <i className="brush-swatch" style={{ backgroundColor: brushColor }} aria-hidden="true" />
          </button>
          <button className={tool === "eraser" ? "active" : ""} disabled={jobActive} onClick={() => onSelectTool(tool === "eraser" ? "none" : "eraser")}>
            <RestoreIcon />
            <span>복원</span>
          </button>
          <button className={tool === "picker" ? "active" : ""} disabled={jobActive} onClick={() => onSelectTool(tool === "picker" ? "none" : "picker")}>
            <PickerIcon />
            <span>색 뽑기</span>
          </button>
        </div>
        <div className="retouch-control-strip">
          <label className="brush-color-control" title="붓 색상">
            <input type="color" value={brushColor} disabled={jobActive} onChange={(event) => onBrushColorChange(event.target.value)} />
          </label>
          <label className="brush-size-control compact">
            <input
              type="range"
              min={4}
              max={90}
              value={brushRadius}
              disabled={jobActive}
              onChange={(event) => onBrushRadiusChange(Number(event.target.value))}
            />
            <strong>{brushRadius}px</strong>
          </label>
          <button className="icon-button" disabled={!canUndo || jobActive} onClick={onUndoRetouch} title="되돌리기 (Ctrl+Z)">
            ↶
          </button>
          <button className="icon-button" disabled={!canRedo || jobActive} onClick={onRedoRetouch} title="다시 실행 (Ctrl+Y / Ctrl+Shift+Z)">
            ↷
          </button>
        </div>
        <div className="retouch-revert-row">
          <button className="secondary compact" disabled={!selectedPage?.inpaintedImagePath || jobActive} onClick={onRevertPage}>
            페이지 되돌리기
          </button>
          <button className="secondary compact" disabled={!inpaintedPageCount || jobActive} onClick={onRevertChapter}>
            전체 되돌리기
          </button>
        </div>
      </section>

      <section className="inpainting-panel review-export-panel">
        <div className="panel-header">
          <h2>결과 출력</h2>
          <small>{inpaintedPageCount}페이지 저장됨</small>
        </div>
        <button className="primary compact" disabled={!currentChapter || jobActive} onClick={onExportResults}>
          PNG 출력
        </button>
      </section>
    </>
  );
}

function InpaintingProgressCard({
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
  const detail =
    jobState.status === "completed" && jobState.detail
      ? jobState.detail
      : jobState.detail || (Number.isFinite(jobState.pageTotal) ? `${jobState.pageTotal}페이지 처리 중` : "인페인팅 작업 진행 중");
  return (
    <div className={`inpainting-progress-card ${jobState.status}`}>
      <div className="progress-meta">
        <span>{jobState.progressText}</span>
        {Number.isFinite(current) && Number.isFinite(total) && (total ?? 0) > 0 ? (
          <strong>
            {current} / {total}
          </strong>
        ) : (
          <strong>진행 중</strong>
        )}
      </div>
      <small>{detail}</small>
      <div className="progress-track" aria-hidden="true">
        <div className="progress-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
      {jobState.status === "starting" || jobState.status === "running" ? (
        <button className="danger compact" onClick={onCancel}>
          취소
        </button>
      ) : null}
    </div>
  );
}

export function DisplayControlPanel({
  showBlockChrome,
  showTextBlocks,
  onToggleChrome,
  onToggleBlocks
}: {
  showBlockChrome: boolean;
  showTextBlocks: boolean;
  onToggleChrome: () => void;
  onToggleBlocks: () => void;
}): React.JSX.Element {
  return (
    <section className="display-panel">
      <h2>표시</h2>
      <div className="display-toggle-row">
        <button className={showBlockChrome ? "active" : ""} onClick={onToggleChrome}>
          배경/테두리
        </button>
        <button className={showTextBlocks ? "active" : ""} onClick={onToggleBlocks}>
          블록 표시
        </button>
      </div>
    </section>
  );
}

function PaintIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 16.5c2.6-.3 4.4.2 5.6 1.4 1.2 1.2 1.7 3 1.4 5.6-2.7.2-5-.4-6.3-1.8-1.1-1.2-1.4-3-.7-5.2Z" />
      <path d="M10.4 16.1 20.7 5.8c.8-.8.8-2 0-2.8-.8-.8-2-.8-2.8 0L7.6 13.3" />
    </svg>
  );
}

function MaskIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 18c3.4-6.4 7.1-10.7 11-13" />
      <path d="M9 19c2.9-4.3 6.1-7.2 9.5-8.8" />
      <path d="M5.5 13.5c3.8.4 7.6 1.8 11.4 4.3" />
      <path d="M4 20h16" />
    </svg>
  );
}

function RestoreIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7 7h7.5a5.5 5.5 0 1 1-4.7 8.3" />
      <path d="M7 7v5H2" />
      <path d="m6.8 7.2 4.5 4.5" />
    </svg>
  );
}

function PickerIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m14.5 4.5 5 5" />
      <path d="m5 19 4.4-1.1 8.9-8.9-3.3-3.3-8.9 8.9L5 19Z" />
      <path d="M7.2 14.8 9.2 16.8" />
    </svg>
  );
}

function EyeIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
