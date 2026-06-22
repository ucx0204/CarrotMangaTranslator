import React from "react";
import { Button } from "../ui";
import { EyeIcon } from "../ui/icons";

type AutoInpaintingStepProps = {
  hasCurrentChapter: boolean;
  hasSelectedPage: boolean;
  inpaintedPageCount: number;
  jobActive: boolean;
  onGoToRetouch: () => void;
  onPeekToggle: () => void;
  onRevertChapter: () => void;
  onRevertPage: () => void;
  onRunChapter: () => void;
  onRunPage: () => void;
  pageTargetCount: number;
  peekAvailable: boolean;
  peeking: boolean;
  pendingPages: number;
  pendingTargetCount: number;
  selectedPageInpainted: boolean;
  totalPages: number;
};

export function AutoInpaintingStep({
  hasCurrentChapter,
  hasSelectedPage,
  inpaintedPageCount,
  jobActive,
  onGoToRetouch,
  onPeekToggle,
  onRevertChapter,
  onRevertPage,
  onRunChapter,
  onRunPage,
  pageTargetCount,
  peekAvailable,
  peeking,
  pendingPages,
  pendingTargetCount,
  selectedPageInpainted,
  totalPages,
}: AutoInpaintingStepProps): React.JSX.Element {
  return (
    <div className="inpaint-step-body">
      <p className="inpaint-step-lead">
        먼저 원문 글자를 자동으로 지웁니다. 한 페이지씩 또는 남은 페이지를 한
        번에 처리할 수 있어요.
      </p>
      <AutoInpaintingRunCard
        hasCurrentChapter={hasCurrentChapter}
        hasSelectedPage={hasSelectedPage}
        jobActive={jobActive}
        onPeekToggle={onPeekToggle}
        onRunChapter={onRunChapter}
        onRunPage={onRunPage}
        pageTargetCount={pageTargetCount}
        peekAvailable={peekAvailable}
        peeking={peeking}
        pendingPages={pendingPages}
        pendingTargetCount={pendingTargetCount}
        totalPages={totalPages}
      />
      <AutoInpaintingRevertActions
        inpaintedPageCount={inpaintedPageCount}
        jobActive={jobActive}
        onRevertChapter={onRevertChapter}
        onRevertPage={onRevertPage}
        selectedPageInpainted={selectedPageInpainted}
      />
      <div className="inpaint-step-nav">
        <span />
        <Button variant="primary" onClick={onGoToRetouch} disabled={jobActive}>
          다음: 보정 →
        </Button>
      </div>
    </div>
  );
}

function AutoInpaintingRunCard({
  hasCurrentChapter,
  hasSelectedPage,
  jobActive,
  onPeekToggle,
  onRunChapter,
  onRunPage,
  pageTargetCount,
  peekAvailable,
  peeking,
  pendingPages,
  pendingTargetCount,
  totalPages,
}: Pick<
  AutoInpaintingStepProps,
  | "hasCurrentChapter"
  | "hasSelectedPage"
  | "jobActive"
  | "onPeekToggle"
  | "onRunChapter"
  | "onRunPage"
  | "pageTargetCount"
  | "peekAvailable"
  | "peeking"
  | "pendingPages"
  | "pendingTargetCount"
  | "totalPages"
>): React.JSX.Element {
  return (
    <div className="inpainting-run-card">
      <span className="inpainting-run-meta">
        {hasCurrentChapter
          ? `남은 ${pendingPages} / ${totalPages}페이지 · ${pendingTargetCount}개 블록`
          : "화가 열려 있지 않습니다."}
      </span>
      <div className="inpainting-action-grid">
        <Button
          variant="primary"
          fullWidth
          disabled={!hasSelectedPage || jobActive || pageTargetCount === 0}
          onClick={onRunPage}
        >
          이 페이지
        </Button>
        <Button
          fullWidth
          disabled={!hasCurrentChapter || jobActive || pendingTargetCount === 0}
          onClick={onRunChapter}
        >
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
      <p className="inpainting-hint">
        블록 모서리의 ‘제외’ 버튼으로 해당 블록을 인페인팅에서 빼거나 다시 넣을
        수 있어요.
      </p>
    </div>
  );
}

function AutoInpaintingRevertActions({
  inpaintedPageCount,
  jobActive,
  onRevertChapter,
  onRevertPage,
  selectedPageInpainted,
}: Pick<
  AutoInpaintingStepProps,
  | "inpaintedPageCount"
  | "jobActive"
  | "onRevertChapter"
  | "onRevertPage"
  | "selectedPageInpainted"
>): React.JSX.Element {
  return (
    <div className="inpaint-revert">
      <span className="inpaint-revert-label">인페인팅 되돌리기</span>
      <div className="inpaint-revert-row">
        <Button
          size="sm"
          variant="ghost"
          disabled={!selectedPageInpainted || jobActive}
          onClick={onRevertPage}
        >
          이 페이지
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!inpaintedPageCount || jobActive}
          onClick={onRevertChapter}
        >
          전체
        </Button>
      </div>
    </div>
  );
}
