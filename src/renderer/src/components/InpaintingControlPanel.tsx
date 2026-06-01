import React from "react";
import type { ChapterSnapshot, JobState, MangaPage, TranslationBlock } from "../../../shared/types";
import type { ProgressSnapshot } from "../lib/jobProgress";

export type InpaintingStage = "pattern" | "finalize" | "review";
export type InpaintingTool = "none" | "brush" | "eraser" | "picker" | "mask";

export type BlockCounts = {
  total: number;
};

export function InpaintingWorkflowPanel({ stage }: { stage: InpaintingStage }): React.JSX.Element {
  const steps: Array<{ id: InpaintingStage; label: string; tone: "pattern" | "finalize" | "review" }> = [
    { id: "pattern", label: "무늬 배경", tone: "pattern" },
    { id: "finalize", label: "최종 처리", tone: "finalize" },
    { id: "review", label: "결과 확인", tone: "review" }
  ];
  const activeIndex = steps.findIndex((step) => step.id === stage);
  return (
    <section className="inpainting-flow-panel" aria-label="인페인팅 단계">
      {steps.map((step, index) => {
        const state = index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
        return (
          <div className={`flow-step ${step.tone} ${state}`} key={step.id}>
            <span className="flow-step-index">{index + 1}</span>
            <span className="flow-step-label">{step.label}</span>
          </div>
        );
      })}
    </section>
  );
}

export function InpaintingControlPanel({
  stage,
  currentChapter,
  selectedPage,
  selectedBlock,
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
  onToggleChrome,
  onToggleBlocks,
  onExportResults
}: {
  stage: InpaintingStage;
  currentChapter: ChapterSnapshot | null;
  selectedPage: MangaPage | null;
  selectedBlock: TranslationBlock | null;
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
  onToggleChrome: () => void;
  onToggleBlocks: () => void;
  onExportResults: () => void;
}): React.JSX.Element {
  const activeInpaintingJob = jobState.kind === "inpainting" && jobState.status !== "idle";
  const totalPages = currentChapter?.pages.length ?? 0;
  const stageTitle = stage === "pattern" ? "무늬 배경 지우기" : stage === "finalize" ? "최종 처리" : "결과 확인";
  const targetLabel = "무늬 배경";
  const targetCount = blockCounts.total;

  return (
    <>
      <section className="inpainting-panel stage-panel">
        <div className="panel-header">
          <h2>{stageTitle}</h2>
          <button className="inpainting-guide-button" onClick={onShowGuide}>
            안내
          </button>
        </div>

        <div className="inpainting-counts">
          <span className="type-stat nonsolid">지울 블록 {blockCounts.total}</span>
          <span className="type-stat review">처리된 페이지 {inpaintedPageCount}</span>
        </div>

        {activeInpaintingJob ? <InpaintingProgressCard jobState={jobState} progressSnapshot={progressSnapshot} /> : null}

        {stage === "pattern" ? (
          <div className={`inpainting-run-card ${stage}`}>
            <div>
              <strong>{targetLabel} 실행</strong>
              <span>{currentChapter ? `${totalPages}페이지 · ${targetCount}개 ${targetLabel} 블록` : "화가 열려 있지 않습니다."}</span>
            </div>
            <div className="inpainting-action-grid">
              <button className="pattern compact" disabled={!selectedPage || jobActive || targetCount === 0} onClick={onRunPage}>
                이 페이지 지우기
              </button>
              <button className="pattern compact" disabled={!currentChapter || jobActive || targetCount === 0} onClick={onRunChapter}>
                전체 페이지 지우기
              </button>
            </div>
          </div>
        ) : stage === "finalize" ? (
          <div className="pending-stage-card finalize">
            <strong>블록 최종 처리</strong>
            <span>{selectedBlock ? "선택한 블록의 폰트, 색상, 위치를 조정하세요." : "캔버스에서 블록을 선택하면 편집 패널이 열립니다."}</span>
          </div>
        ) : (
          <div className="pending-stage-card review">
            <strong>결과 확인</strong>
            <span>{inpaintedPageCount}페이지에 인페인팅 결과가 저장되어 있습니다.</span>
            <button className="primary compact" disabled={!currentChapter || jobActive} onClick={onExportResults}>
              PNG 출력
            </button>
          </div>
        )}
      </section>

      {stage === "pattern" ? (
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
              마스크 비우기
            </button>
          </div>
          <div className="drawn-mask-actions">
            <button className="pattern compact" disabled={jobActive || !selectedPage || maskStrokeCount === 0} onClick={onRunDrawnPattern}>
              그린 영역 지우기
            </button>
          </div>
        </section>
      ) : null}

      {stage !== "review" ? (
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
              <span>복원 붓</span>
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
      ) : null}

      <DisplayControlPanel
        showBlockChrome={showBlockChrome}
        showTextBlocks={showTextBlocks}
        onToggleChrome={onToggleChrome}
        onToggleBlocks={onToggleBlocks}
      />
    </>
  );
}

function InpaintingProgressCard({ jobState, progressSnapshot }: { jobState: JobState; progressSnapshot: ProgressSnapshot | null }): React.JSX.Element {
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
