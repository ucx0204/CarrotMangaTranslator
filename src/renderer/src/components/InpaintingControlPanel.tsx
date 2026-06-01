import React from "react";
import type { JobState } from "../../../shared/types";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { useInpainting } from "../inpainting/InpaintingContext";
import { Button, IconButton } from "./ui";
import { BrushIcon, EyeIcon, MaskIcon, PickerIcon, RedoIcon, RestoreIcon, UndoIcon } from "./ui/icons";

export type { InpaintingTool, BlockCounts } from "../inpainting/InpaintingContext";

type FlowStep = "auto" | "retouch" | "export";

const STEP_ORDER: FlowStep[] = ["auto", "retouch", "export"];
const STEP_LABELS: Record<FlowStep, string> = { auto: "자동", retouch: "보정", export: "출력" };

export function InpaintingControlPanel(): React.JSX.Element {
  const {
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
    onPeekToggle,
    onToggleChrome,
    onToggleBlocks,
    onExportResults,
    onCancelJob
  } = useInpainting();
  const [step, setStep] = React.useState<FlowStep>("auto");
  const activeInpaintingJob = jobState.kind === "inpainting" && jobState.status !== "idle";
  const totalPages = currentChapter?.pages.length ?? 0;
  const pageTargetCount = blockCounts.selectedPage;
  const pendingTargetCount = blockCounts.pendingTotal;
  const stepIndex = STEP_ORDER.indexOf(step);

  return (
    <section className="inpainting-panel inpaint-flow">
      <div className="inpaint-flow-head">
        <div className="inpaint-stepper" role="tablist" aria-label="인페인팅 단계">
          {STEP_ORDER.map((value, index) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={step === value}
              className={`inpaint-step ${step === value ? "active" : ""} ${index < stepIndex ? "done" : ""}`}
              onClick={() => setStep(value)}
            >
              <span className="inpaint-step-num">{index + 1}</span>
              <span className="inpaint-step-label">{STEP_LABELS[value]}</span>
            </button>
          ))}
        </div>
        <div className="inpaint-flow-display">
          <button className={`chip-toggle ${showTextBlocks ? "active" : ""}`} onClick={onToggleBlocks} title="블록 표시 켜기/끄기">
            블록
          </button>
          <button className={`chip-toggle ${showBlockChrome ? "active" : ""}`} onClick={onToggleChrome} title="배경/테두리 표시 켜기/끄기">
            테두리
          </button>
          <button className="inpainting-guide-button" onClick={onShowGuide} title="인페인팅 사용법">
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

      {step === "auto" ? (
        <div className="inpaint-step-body">
          <p className="inpaint-step-lead">먼저 원문 배경을 자동으로 지웁니다. 한 페이지씩 또는 남은 페이지를 한 번에 처리할 수 있어요.</p>
          <div className="inpainting-run-card pattern">
            <span className="inpainting-run-meta">
              {currentChapter ? `남은 ${blockCounts.pendingPages} / ${totalPages}페이지 · ${pendingTargetCount}개 블록` : "화가 열려 있지 않습니다."}
            </span>
            <div className="inpainting-action-grid">
              <Button variant="primary" fullWidth disabled={!selectedPage || jobActive || pageTargetCount === 0} onClick={onRunPage}>
                이 페이지
              </Button>
              <Button fullWidth disabled={!currentChapter || jobActive || pendingTargetCount === 0} onClick={onRunChapter}>
                남은 페이지
              </Button>
            </div>
            <button
              type="button"
              className={`peek-button ${peeking ? "active" : ""}`}
              disabled={!peekAvailable || jobActive}
              aria-pressed={peeking}
              onClick={onPeekToggle}
            >
              <EyeIcon size={16} />
              <span>{peeking ? "원본 표시 중 (눌러서 끄기)" : "원본 비교"}</span>
            </button>
            <p className="inpainting-hint">블록 모서리의 ‘제외’ 버튼으로 해당 블록을 인페인팅에서 빼거나 다시 넣을 수 있어요.</p>
          </div>
          <div className="inpaint-step-nav">
            <span />
            <Button variant="primary" onClick={() => setStep("retouch")} disabled={jobActive}>
              다음: 보정 →
            </Button>
          </div>
        </div>
      ) : null}

      {step === "retouch" ? (
        <div className="inpaint-step-body">
          <p className="inpaint-step-lead">남은 자국을 직접 다듬습니다. 효과음은 그려서 지우고, 자잘한 부분은 붓·복원으로 정리하세요.</p>

          <div className="inpaint-group">
            <div className="inpaint-group-head">
              <h3>그려서 지우기</h3>
              <small>{maskStrokeCount > 0 ? `그린 영역 ${maskStrokeCount}개` : "효과음 보정"}</small>
            </div>
            <div className="retouch-toolbar compact-toolbar">
              <button className={tool === "mask" ? "active mask-tool" : "mask-tool"} disabled={jobActive} onClick={() => onSelectTool(tool === "mask" ? "none" : "mask")}>
                <MaskIcon size={18} />
                <span>마스크 붓</span>
              </button>
              <Button size="sm" disabled={jobActive || maskStrokeCount === 0} onClick={onClearPatternMask}>
                비우기
              </Button>
            </div>
            <Button variant="primary" fullWidth disabled={jobActive || !selectedPage || maskStrokeCount === 0} onClick={onRunDrawnPattern}>
              그린 영역 지우기
            </Button>
          </div>

          <div className="inpaint-group">
            <div className="inpaint-group-head">
              <h3>수동 보정</h3>
              <small>Ctrl+Z / Ctrl+Y</small>
            </div>
            <div className="retouch-toolbar">
              <button className={tool === "brush" ? "active" : ""} disabled={jobActive} onClick={() => onSelectTool(tool === "brush" ? "none" : "brush")}>
                <BrushIcon size={18} />
                <span>붓</span>
                <i className="brush-swatch" style={{ backgroundColor: brushColor }} aria-hidden="true" />
              </button>
              <button className={tool === "eraser" ? "active" : ""} disabled={jobActive} onClick={() => onSelectTool(tool === "eraser" ? "none" : "eraser")}>
                <RestoreIcon size={18} />
                <span>복원</span>
              </button>
              <button className={tool === "picker" ? "active" : ""} disabled={jobActive} onClick={() => onSelectTool(tool === "picker" ? "none" : "picker")}>
                <PickerIcon size={18} />
                <span>색 뽑기</span>
              </button>
            </div>
            <div className="retouch-control-strip">
              <label className="brush-color-control" title="붓 색상">
                <input type="color" value={brushColor} disabled={jobActive} onChange={(event) => onBrushColorChange(event.target.value)} />
              </label>
              <label className="brush-size-control compact">
                <input type="range" min={4} max={90} value={brushRadius} disabled={jobActive} onChange={(event) => onBrushRadiusChange(Number(event.target.value))} />
                <strong>{brushRadius}px</strong>
              </label>
              <IconButton size="sm" label="되돌리기 (Ctrl+Z)" title="되돌리기 (Ctrl+Z)" disabled={!canUndo || jobActive} onClick={onUndoRetouch}>
                <UndoIcon size={16} />
              </IconButton>
              <IconButton size="sm" label="다시 실행 (Ctrl+Y)" title="다시 실행 (Ctrl+Y / Ctrl+Shift+Z)" disabled={!canRedo || jobActive} onClick={onRedoRetouch}>
                <RedoIcon size={16} />
              </IconButton>
            </div>
            <div className="retouch-revert-row">
              <Button size="sm" disabled={!selectedPage?.inpaintedImagePath || jobActive} onClick={onRevertPage}>
                페이지 되돌리기
              </Button>
              <Button size="sm" disabled={!inpaintedPageCount || jobActive} onClick={onRevertChapter}>
                전체 되돌리기
              </Button>
            </div>
          </div>

          <div className="inpaint-step-nav">
            <Button variant="ghost" onClick={() => setStep("auto")}>
              ← 자동
            </Button>
            <Button variant="primary" onClick={() => setStep("export")} disabled={jobActive}>
              출력 →
            </Button>
          </div>
        </div>
      ) : null}

      {step === "export" ? (
        <div className="inpaint-step-body">
          <p className="inpaint-step-lead">블록의 폰트·색·위치를 정리한 뒤, 번역이 얹힌 PNG로 내보냅니다.</p>
          <div className="inpaint-group">
            <div className="inpaint-group-head">
              <h3>결과 출력</h3>
              <small>{inpaintedPageCount}페이지 저장됨</small>
            </div>
            <Button variant="primary" fullWidth disabled={!currentChapter || jobActive} onClick={onExportResults}>
              PNG 출력
            </Button>
          </div>
          <div className="inpaint-step-nav">
            <Button variant="ghost" onClick={() => setStep("retouch")}>
              ← 보정
            </Button>
            <span />
          </div>
        </div>
      ) : null}
    </section>
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
        <Button variant="danger" size="sm" onClick={onCancel}>
          취소
        </Button>
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
