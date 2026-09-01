/** @vitest-environment jsdom */

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusDockButton } from "../src/renderer/src/components/StatusDockButton";
import {
  ResearchJobDetails,
  StatusJobHistory,
} from "../src/renderer/src/components/StatusPopoverDetails";
import type { AppOperationActivityEvent } from "../src/shared/appOperationTypes";
import type { JobState } from "../src/shared/jobTypes";
import { requestStatusCenterOpen } from "../src/renderer/src/lib/statusCenterEvents";
import type { StatusCenterHistoryEntry } from "../src/renderer/src/lib/statusCenterHistoryStore";
import {
  normalizeCompletionSoundPreferences,
  type ResolvedCompletionSoundPreferences,
} from "../src/renderer/src/hooks/useCompletionSound";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("status dock", () => {
  it("shows unread state without forcing open and exposes the latest line", async () => {
    render(
      <StatusDockButton
        jobState={makeJobState()}
        progressSnapshot={null}
        showProgressBar={false}
        statusLines={["가장 최근", "이전 상태"]}
        onCancelJob={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", {
      name: "작업 센터 열기",
    });

    expect(screen.queryByRole("region", { name: "작업 센터" })).toBeNull();
    await waitFor(() => expect(button.classList.contains("unread")).toBe(true));
    expect(button.getAttribute("title")).toBe("최근 상태: 가장 최근");
  });

  it("renders chapter labels with an app tooltip for the work title", () => {
    render(
      <StatusDockButton
        jobState={makeJobState()}
        progressSnapshot={null}
        showProgressBar={false}
        statusEntries={[
          {
            message: "Paddle OCR 선분석 완료",
            context: {
              chapterId: "chapter-2",
              chapterTitle: "2화",
              workTitle: "샘플 작품",
            },
          },
          {
            message: "40 / 40 페이지 번역 중",
            context: {
              chapterId: "chapter-1",
              chapterTitle: "1화",
              workTitle: "샘플 작품",
            },
          },
          {
            message: "38 / 38 페이지 원문 지우기 완료",
            context: {
              chapterId: "chapter-3",
              chapterTitle: "3화",
            },
          },
        ]}
        statusLines={[
          "Paddle OCR 선분석 완료",
          "40 / 40 페이지 번역 중",
          "38 / 38 페이지 원문 지우기 완료",
        ]}
        onCancelJob={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    const firstChapter = screen.getByText("· 1화");
    expect(firstChapter.getAttribute("title")).toBeNull();
    expect(firstChapter.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      screen.getAllByRole("tooltip").map((tooltip) => tooltip.textContent),
    ).toEqual(["샘플 작품", "샘플 작품"]);
    const chapterWithoutWorkTitle = screen.getByText("· 3화");
    expect(chapterWithoutWorkTitle.getAttribute("aria-describedby")).toBeNull();
  });

  it("opens accessibly, clears history, and closes on Escape or outside click", () => {
    const onClear = vi.fn();
    render(
      <StatusDockButton
        jobState={makeJobState()}
        progressSnapshot={null}
        showProgressBar={false}
        statusLines={["가장 최근", "이전 상태"]}
        onCancelJob={vi.fn()}
        onClear={onClear}
      />,
    );
    const button = screen.getByRole("button", {
      name: "작업 센터 열기",
    });
    fireEvent.click(button);

    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("region", { name: "작업 센터" })).not.toBeNull();
    expect(screen.getAllByText(/상태|최근/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "완료 알림음 설정" }));
    expect(
      screen.getByRole("group", { name: "완료 알림음 설정" }),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "전체 알림음 켜기" }));
    fireEvent.click(screen.getByRole("button", { name: "상태 기록 지우기" }));
    expect(onClear).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("region", { name: "작업 센터" })).toBeNull();
    fireEvent.click(button);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "작업 센터" })).toBeNull();
    fireEvent.click(button);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("region", { name: "작업 센터" })).toBeNull();
  });

  it("opens sound settings without toggling mute and controls each completion sound", () => {
    const onChange = vi.fn();
    render(<SoundStatusDockHarness onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    const soundSettings = screen.getByRole("button", {
      name: "완료 알림음 설정",
    });
    fireEvent.click(soundSettings);
    expect(onChange).not.toHaveBeenCalled();
    expect(soundSettings.getAttribute("aria-expanded")).toBe("true");

    const slider = screen.getByRole("slider", {
      name: "완료 알림음 볼륨",
    });
    expect((slider as HTMLInputElement).value).toBe("35");
    const allSounds = screen.getByRole("button", { name: "전체 알림음 켜기" });
    const translation = screen.getByRole("button", { name: "번역 완료 끄기" });
    const soundEffect = screen.getByRole("button", {
      name: "효과음 번역 완료 끄기",
    });
    const sourceErasing = screen.getByRole("button", {
      name: "원문 지우기 완료 끄기",
    });
    const research = screen.getByRole("button", {
      name: "인터넷 조사 완료 끄기",
    });
    expect(allSounds.getAttribute("aria-pressed")).toBe("true");
    expect(translation.getAttribute("aria-pressed")).toBe("false");
    expect(soundEffect.getAttribute("aria-pressed")).toBe("false");
    expect(sourceErasing.getAttribute("aria-pressed")).toBe("false");
    expect(research.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(allSounds);
    expect(onChange).toHaveBeenLastCalledWith({
      muted: false,
      volume: 0.35,
      translationMuted: false,
      soundEffectMuted: false,
      sourceErasingMuted: false,
      researchMuted: false,
    });

    fireEvent.click(soundEffect);
    expect(onChange).toHaveBeenLastCalledWith({
      muted: false,
      volume: 0.35,
      translationMuted: false,
      soundEffectMuted: true,
      sourceErasingMuted: false,
      researchMuted: false,
    });

    fireEvent.click(research);
    expect(onChange).toHaveBeenLastCalledWith({
      muted: false,
      volume: 0.35,
      translationMuted: false,
      soundEffectMuted: true,
      sourceErasingMuted: false,
      researchMuted: true,
    });

    fireEvent.change(slider, { target: { value: "72" } });
    expect(onChange).toHaveBeenLastCalledWith({
      muted: false,
      volume: 0.72,
      translationMuted: false,
      soundEffectMuted: true,
      sourceErasingMuted: false,
      researchMuted: true,
    });
  });

  it("keeps a failed job visibly red independently of unread history", () => {
    render(
      <StatusDockButton
        jobState={makeJobState({ status: "failed", detail: "raw failure" })}
        progressSnapshot={null}
        showProgressBar={false}
        statusLines={[]}
        onCancelJob={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(
      screen
        .getByRole("button", { name: "작업 센터 열기" })
        .classList.contains("failed"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    expect(screen.queryByRole("log")).toBeNull();
    expect(screen.queryByRole("region", { name: "상태 기록" })).toBeNull();
  });

  it("keeps job progress and cancellation in the activity center", () => {
    const onCancelJob = vi.fn();
    render(
      <StatusDockButton
        jobState={makeJobState({
          progressText: "OCR 처리 중",
          status: "running",
        })}
        progressSnapshot={{
          current: 2,
          mode: "determinate",
          ratio: 0.5,
          total: 4,
        }}
        showProgressBar
        statusLines={["OCR 처리 중", "이전 단계"]}
        onCancelJob={onCancelJob}
        onClear={vi.fn()}
      />,
    );

    const dockButton = screen.getByRole("button", { name: "작업 센터 열기" });
    expect(dockButton.classList.contains("running")).toBe(true);
    expect(dockButton.querySelector(".status-dock-indicator")).not.toBeNull();
    expect(dockButton.querySelector(".status-dock-bell")).not.toBeNull();
    fireEvent.click(dockButton);
    const center = screen.getByRole("region", { name: "작업 센터" });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "2",
    );
    expect(within(center).getAllByText("OCR 처리 중")).toHaveLength(1);
    expect(within(center).getByText("이전 단계")).not.toBeNull();
    expect(center.querySelector(".job-pill")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "현재 작업 취소" }));
    expect(onCancelJob).toHaveBeenCalledOnce();
  });

  it("does not render a stale full progress bar before an active job settles", () => {
    render(
      <StatusDockButton
        jobState={makeJobState({
          progressText: "마무리 중",
          status: "running",
        })}
        progressSnapshot={{
          current: 4,
          mode: "determinate",
          ratio: 1,
          total: 4,
        }}
        showProgressBar
        statusLines={["마무리 중"]}
        onCancelJob={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    const center = screen.getByRole("region", { name: "작업 센터" });
    expect(center.querySelector(".job-pill")?.textContent).toBe("마무리 중");
    expect(within(center).queryByRole("progressbar")).toBeNull();
  });

  it("shows import preparation in the activity center and cancels that operation", () => {
    const onCancelOperation = vi.fn();
    render(
      <StatusDockButton
        jobState={makeJobState()}
        operationActivity={makeOperationActivity()}
        progressSnapshot={null}
        showProgressBar={false}
        statusLines={[]}
        onCancelJob={vi.fn()}
        onCancelOperation={onCancelOperation}
        onClear={vi.fn()}
      />,
    );

    const dockButton = screen.getByRole("button", { name: "작업 센터 열기" });
    expect(dockButton.classList.contains("running")).toBe(true);
    expect(dockButton.getAttribute("title")).toContain("PDF 가져오기 준비");
    expect(dockButton.getAttribute("title")).toContain("변환·추출");

    fireEvent.click(dockButton);
    expect(
      within(screen.getByRole("region", { name: "작업 센터" })).getByText(
        /PDF 가져오기 준비.*변환·추출/,
      ),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "현재 작업 취소" }));
    expect(onCancelOperation).toHaveBeenCalledOnce();
  });

  it("opens from a global task link and exposes progress and waiting state", () => {
    render(
      <StatusDockButton
        jobState={makeJobState()}
        operationActivity={makeOperationActivity({
          progressCurrent: 1,
          progressTotal: 4,
          progressUnit: "items",
          waitingForUser: true,
        })}
        progressSnapshot={null}
        showProgressBar={false}
        statusLines={[]}
        onCancelJob={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    act(() => requestStatusCenterOpen());
    expect(screen.getByRole("region", { name: "작업 센터" })).not.toBeNull();
    expect(
      screen.getByText("브라우저에서 사용자 작업을 기다리는 중"),
    ).not.toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "1",
    );
    expect(screen.queryByRole("button", { name: "가져온 화 열기" })).toBeNull();
  });

  it("moves a completed import operation into recent history", async () => {
    const commonProps = {
      jobState: makeJobState(),
      progressSnapshot: null,
      showProgressBar: false,
      statusLines: [] as string[],
      onCancelJob: vi.fn(),
      onClear: vi.fn(),
    };
    const view = render(
      <StatusDockButton
        {...commonProps}
        operationActivity={makeOperationActivity()}
      />,
    );
    view.rerender(
      <StatusDockButton
        {...commonProps}
        operationActivity={makeOperationActivity({
          status: "completed",
          phase: "import-source-validating",
          cancellable: false,
          updatedAt: 2,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    await waitFor(() =>
      expect(screen.getByText(/PDF 가져오기 준비.*완료/)).not.toBeNull(),
    );
  });

  it("shows three recent jobs before scrolling the history internally", () => {
    const entries: StatusCenterHistoryEntry[] = Array.from(
      { length: 4 },
      (_, index) => ({
        id: `operation-${index}`,
        source: "operation",
        kind: "library-import",
        status: "completed",
        completedAt: index,
      }),
    );
    render(<StatusJobHistory entries={entries} />);

    const list = screen.getByRole("list", { name: "최근 작업" });
    expect(list.classList.contains("scrollable")).toBe(true);
    expect(list.dataset.visibleLimit).toBe("3");
    expect(list.getAttribute("tabindex")).toBe("0");
    expect(list.children).toHaveLength(4);
  });

  it("does not reserve recent-history space when there are no entries", () => {
    const view = render(<StatusJobHistory entries={[]} />);

    expect(view.container.childElementCount).toBe(0);
  });

  it("does not reserve research-detail space for another job kind", () => {
    const view = render(<ResearchJobDetails jobState={makeJobState()} />);

    expect(view.container.childElementCount).toBe(0);
  });

  it("uses a concise kind and status when a job has no saved label", () => {
    render(
      <StatusJobHistory
        entries={[
          {
            id: "inpainting-cancelled",
            source: "job",
            kind: "inpainting",
            status: "cancelled",
            completedAt: 1,
          },
        ]}
      />,
    );

    expect(screen.getByText("지우기·인페인팅 · 취소됨")).not.toBeNull();
  });

  it("turns a completed translation into a result card with next actions", () => {
    const onReviewResults = vi.fn();
    const onOpenExport = vi.fn();
    render(
      <StatusDockButton
        jobState={makeJobState({
          kind: "gemma-analysis",
          status: "completed",
          progressText: "3페이지 번역 완료",
          detail: "검토가 필요한 블록 1개가 있습니다.",
          pageTotal: 3,
        })}
        progressSnapshot={{
          current: 3,
          mode: "determinate",
          ratio: 1,
          total: 3,
        }}
        showProgressBar={false}
        statusLines={["3페이지 번역을 완료했습니다."]}
        onCancelJob={vi.fn()}
        onClear={vi.fn()}
        onOpenExport={onOpenExport}
        onReviewResults={onReviewResults}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    expect(screen.getByText("작업이 완료됐습니다")).not.toBeNull();
    expect(screen.getByText("3페이지 처리 완료")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "결과 검토" }));
    expect(onReviewResults).toHaveBeenCalledOnce();
    expect(screen.queryByRole("region", { name: "작업 센터" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    fireEvent.click(screen.getByRole("button", { name: "내보내기" }));
    expect(onOpenExport).toHaveBeenCalledOnce();
  });

  it("loads older in-memory status rows in batches at the bottom", () => {
    const statusLines = Array.from(
      { length: 40 },
      (_, index) => `상태 기록 ${index + 1}`,
    );
    render(
      <StatusDockButton
        jobState={makeJobState()}
        progressSnapshot={null}
        showProgressBar={false}
        statusLines={statusLines}
        onCancelJob={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    const log = screen.getByRole("log");
    expect(log.classList.contains("scrollable")).toBe(true);
    expect(log.dataset.visibleLimit).toBe("5");
    expect(log.dataset.loadedCount).toBe("16");
    expect(log.childElementCount).toBe(16);
    expect(within(log).getByText("상태 기록 1")).not.toBeNull();
    expect(within(log).queryByText("상태 기록 17")).toBeNull();

    setScrollMetrics(log, { clientHeight: 200, scrollHeight: 800 });
    log.scrollTop = 300;
    fireEvent.scroll(log);
    expect(log.childElementCount).toBe(16);

    log.scrollTop = 600;
    fireEvent.scroll(log);
    expect(log.dataset.loadedCount).toBe("32");
    expect(within(log).getByText("상태 기록 32")).not.toBeNull();
    expect(within(log).queryByText("상태 기록 33")).toBeNull();

    setScrollMetrics(log, { clientHeight: 200, scrollHeight: 1_600 });
    log.scrollTop = 1_400;
    fireEvent.scroll(log);
    expect(log.dataset.loadedCount).toBe("40");
    expect(within(log).getByText("상태 기록 40")).not.toBeNull();

    fireEvent.scroll(log);
    expect(log.childElementCount).toBe(40);
  });

  it("starts from the latest batch again after the session log is cleared", async () => {
    const commonProps = {
      jobState: makeJobState(),
      progressSnapshot: null,
      showProgressBar: false,
      onCancelJob: vi.fn(),
      onClear: vi.fn(),
    };
    const view = render(
      <StatusDockButton
        {...commonProps}
        statusLines={Array.from(
          { length: 40 },
          (_, index) => `기존 기록 ${index + 1}`,
        )}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    const log = screen.getByRole("log");
    setScrollMetrics(log, { clientHeight: 200, scrollHeight: 800 });
    log.scrollTop = 600;
    fireEvent.scroll(log);
    expect(log.dataset.loadedCount).toBe("32");

    view.rerender(<StatusDockButton {...commonProps} statusLines={[]} />);
    await waitFor(() => expect(screen.queryByRole("log")).toBeNull());
    view.rerender(
      <StatusDockButton
        {...commonProps}
        statusLines={Array.from(
          { length: 24 },
          (_, index) => `새 기록 ${index + 1}`,
        )}
      />,
    );

    const newLog = await screen.findByRole("log");
    expect(newLog.dataset.loadedCount).toBe("16");
    expect(within(newLog).queryByText("새 기록 17")).toBeNull();
  });

  it("offers page-level retry and the error report for failed work", () => {
    const onRetryPage = vi.fn();
    const onOpenErrorReport = vi.fn();
    render(
      <StatusDockButton
        jobState={makeJobState({
          status: "failed",
          progressText: "일부 페이지 실패",
        })}
        progressSnapshot={null}
        showProgressBar={false}
        statusLines={["003.jpg 실패"]}
        failedPages={[
          { id: "page-3", name: "003.jpg", error: "OCR 시간 초과" },
        ]}
        onRetryPage={onRetryPage}
        onOpenErrorReport={onOpenErrorReport}
        onCancelJob={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    fireEvent.click(screen.getByRole("button", { name: "오류 보고" }));
    expect(onOpenErrorReport).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRetryPage).toHaveBeenCalledWith("page-3");
    expect(screen.queryByRole("region", { name: "작업 센터" })).toBeNull();
  });

  it("keeps the previous terminal job in recent history", async () => {
    const commonProps = {
      progressSnapshot: null,
      showProgressBar: false,
      statusLines: ["새 작업 시작"],
      onCancelJob: vi.fn(),
      onClear: vi.fn(),
    };
    const view = render(
      <StatusDockButton
        {...commonProps}
        jobState={makeJobState({
          id: "job-completed",
          status: "completed",
          progressText: "이전 작업 완료",
          pageTotal: 9,
        })}
      />,
    );
    view.rerender(
      <StatusDockButton
        {...commonProps}
        jobState={makeJobState({
          id: "job-running",
          status: "running",
          progressText: "새 작업 진행 중",
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    await waitFor(() =>
      expect(screen.getByText("이전 작업 완료")).not.toBeNull(),
    );
    expect(screen.getByText("9페이지 처리 완료")).not.toBeNull();

    view.rerender(
      <StatusDockButton
        {...commonProps}
        jobState={makeJobState()}
        operationActivity={makeOperationActivity({
          status: "failed",
          cancellable: false,
          updatedAt: 3,
        })}
      />,
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "작업 센터 열기" })
          .classList.contains("failed"),
      ).toBe(true),
    );
    expect(screen.getByText("이전 작업 완료")).not.toBeNull();
  });
});

function SoundStatusDockHarness({
  onChange,
}: {
  onChange: (preferences: ResolvedCompletionSoundPreferences) => void;
}): React.JSX.Element {
  const [preferences, setPreferences] = React.useState({
    muted: true,
    volume: 0.35,
    translationMuted: false,
    soundEffectMuted: false,
    sourceErasingMuted: false,
    researchMuted: false,
  });
  return (
    <StatusDockButton
      completionSoundMuted={preferences.muted}
      completionSoundVolume={preferences.volume}
      completionSoundTranslationMuted={preferences.translationMuted}
      completionSoundSoundEffectMuted={preferences.soundEffectMuted}
      completionSoundSourceErasingMuted={preferences.sourceErasingMuted}
      completionSoundResearchMuted={preferences.researchMuted}
      jobState={makeJobState()}
      progressSnapshot={null}
      showProgressBar={false}
      statusLines={[]}
      onCancelJob={vi.fn()}
      onClear={vi.fn()}
      onCompletionSoundChange={(next) => {
        const resolved = normalizeCompletionSoundPreferences(next);
        setPreferences(resolved);
        onChange(resolved);
      }}
    />
  );
}

function makeOperationActivity(
  overrides: Partial<AppOperationActivityEvent> = {},
): AppOperationActivityEvent {
  return {
    id: "import-preview-1",
    kind: "library-import-preview",
    status: "running",
    phase: "import-source-converting",
    sourceKind: "pdf",
    mutatesLibrary: false,
    cancellable: true,
    startedAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeJobState(overrides: Partial<JobState> = {}): JobState {
  return {
    id: "job-1",
    kind: "inpainting",
    progressText: "대기",
    status: "idle",
    ...overrides,
  };
}

function setScrollMetrics(
  element: HTMLElement,
  metrics: { clientHeight: number; scrollHeight: number },
): void {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: metrics.clientHeight },
    scrollHeight: { configurable: true, value: metrics.scrollHeight },
    scrollTop: { configurable: true, value: 0, writable: true },
  });
}
